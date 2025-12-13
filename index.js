import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Standard dotenv config (looks for .env in current dir, but we will use Platform Secrets)
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;

const CORS_ORIGIN = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: CORS_ORIGIN,
        methods: ["GET", "POST"],
        credentials: true
    }
});

const activeUsers = new Map();
const ticketRooms = new Map();

app.get("/api/active-users", (req, res) => {
    const onlineUsers = Array.from(activeUsers.keys());
    res.json({ users: onlineUsers });
});

app.get("/api/active-users/:ticketId", (req, res) => {
    const { ticketId } = req.params;
    const room = io.sockets.adapter.rooms.get(`ticket:${ticketId}`);

    if (!room) {
        return res.json({ users: [] });
    }

    const userIds = new Set();
    for (const socketId of room) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket && socket.data.userId) {
            userIds.add(socket.data.userId);
        }
    }

    res.json({ users: Array.from(userIds) });
});

// Send notification endpoint
app.post("/api/send-notification", (req, res) => {
    const { recipientId, notification } = req.body;

    if (!recipientId || !notification) {
        return res.status(400).json({ error: "Missing recipientId or notification" });
    }

    const userSockets = activeUsers.get(recipientId);
    if (userSockets && userSockets.size > 0) {
        // Emit to all sockets for this user
        for (const socketId of userSockets) {
            io.to(socketId).emit("new-notification", notification);
        }
        console.log(`Notification sent to user ${recipientId} on ${userSockets.size} devices`);
        return res.json({ success: true, delivered: true });
    }

    console.log(`Notification saved but user ${recipientId} not connected`);
    res.json({ success: true, delivered: false });
});

// Authentication middleware
// Authentication middleware
io.use((socket, next) => {
    const { userId, role } = socket.handshake.auth;

    if (!userId) {
        console.log("Connection rejected: No userId provided");
        return next(new Error("Authentication required: userId missing"));
    }

    socket.data.userId = userId;
    socket.data.role = role || "user";
    next();
});

io.on("connection", (socket) => {
    const userId = socket.data.userId;
    const userRole = socket.data.role;

    // Store user connection
    if (!activeUsers.has(userId)) {
        activeUsers.set(userId, new Set());
        // First connection for this user - broadcast ONLINE
        io.emit("user-online", { userId });
        console.log(`User online: ${userId}`);
    }
    activeUsers.get(userId).add(socket.id);

    console.log(`User connected: ${userId} (${userRole}) - Socket ID: ${socket.id}`);

    // Join ticket room
    socket.on("join-ticket", (ticketId) => {
        socket.join(`ticket:${ticketId}`);

        if (!ticketRooms.has(ticketId)) {
            ticketRooms.set(ticketId, new Set());
        }
        ticketRooms.get(ticketId).add(socket.id);

        console.log(`User ${userId} joined ticket:${ticketId}`);
    });

    // Leave ticket room
    socket.on("leave-ticket", (ticketId) => {
        socket.leave(`ticket:${ticketId}`);

        if (ticketRooms.has(ticketId)) {
            ticketRooms.get(ticketId).delete(socket.id);
        }

        console.log(`User ${userId} left ticket:${ticketId}`);
    });

    // New message
    socket.on("send-message", (data) => {
        const { ticketId, message } = data;

        // Broadcast to all users in the ticket room except sender
        socket.to(`ticket:${ticketId}`).emit("new-message", {
            ticketId,
            message
        });

        console.log(`Message sent in ticket:${ticketId}`);
    });

    // Typing indicator
    socket.on("typing", (data) => {
        const { ticketId, isTyping } = data;

        console.log(`User ${userId} typing in ticket:${ticketId} - isTyping: ${isTyping}`);

        socket.to(`ticket:${ticketId}`).emit("user-typing", {
            ticketId,
            userId,
            isTyping
        });
    });

    // Ticket status update
    socket.on("ticket-updated", (data) => {
        const { ticketId, updates } = data;

        socket.to(`ticket:${ticketId}`).emit("ticket-status-changed", {
            ticketId,
            updates
        });
    });

    // Disconnect
    socket.on("disconnect", () => {
        // Remove this socket for the user
        if (activeUsers.has(userId)) {
            const userSockets = activeUsers.get(userId);
            userSockets.delete(socket.id);

            // If no more connections, user is OFFLINE
            if (userSockets.size === 0) {
                activeUsers.delete(userId);
                io.emit("user-offline", { userId });
                console.log(`User offline: ${userId}`);
            }
        }

        // Remove from all ticket rooms
        for (const [ticketId, sockets] of ticketRooms.entries()) {
            sockets.delete(socket.id);
            if (sockets.size === 0) {
                ticketRooms.delete(ticketId);
            }
        }

        console.log(`Socket disconnected: ${socket.id} (User: ${userId})`);
    });
});

httpServer.listen(PORT, () => {
    console.log(`Socket.IO server running on port ${PORT}`);
    console.log(`CORS origin: ${CORS_ORIGIN}`);
});
