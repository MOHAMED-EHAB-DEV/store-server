import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";

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
    credentials: true,
  },
});

// ─── State ───────────────────────────────────────────────────────────────────

/** Authenticated users: userId → Set<socketId> */
const activeUsers = new Map();

/** Anonymous / visitor tracking: visitorId → Set<socketId> */
const onlineVisitors = new Map();

const ticketRooms = new Map();

// ─── Helper ───────────────────────────────────────────────────────────────────

function getOnlineCount() {
  return onlineVisitors.size;
}

function broadcastOnlineCount() {
  io.emit("online-count", { count: getOnlineCount() });
}

// ─── REST Endpoints ──────────────────────────────────────────────────────────

app.get("/api/active-users", (_req, res) => {
  res.json({ users: Array.from(activeUsers.keys()) });
});

app.get("/api/online-count", (_req, res) => {
  res.json({ count: getOnlineCount() });
});

app.get("/api/active-users/:ticketId", (req, res) => {
  const { ticketId } = req.params;
  const room = io.sockets.adapter.rooms.get(`ticket:${ticketId}`);

  if (!room) return res.json({ users: [] });

  const userIds = new Set();
  for (const socketId of room) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.data.userId) {
      userIds.add(socket.data.userId);
    }
  }

  res.json({ users: Array.from(userIds) });
});

app.post("/api/send-notification", (req, res) => {
  const { recipientId, notification } = req.body;

  if (!recipientId || !notification) {
    return res
      .status(400)
      .json({ error: "Missing recipientId or notification" });
  }

  const userSockets = activeUsers.get(recipientId);
  if (userSockets && userSockets.size > 0) {
    for (const socketId of userSockets) {
      io.to(socketId).emit("new-notification", notification);
    }
    console.log(
      `Notification sent to user ${recipientId} on ${userSockets.size} devices`,
    );
    return res.json({ success: true, delivered: true });
  }

  console.log(`Notification saved but user ${recipientId} not connected`);
  res.json({ success: true, delivered: false });
});

// ─── Socket Auth Middleware ───────────────────────────────────────────────────

io.use((socket, next) => {
  const { userId, role, visitorId } = socket.handshake.auth;

  // visitorId is always required (even for guests); userId is optional
  if (!visitorId) {
    return next(new Error("Authentication required: visitorId missing"));
  }

  socket.data.visitorId = visitorId;
  socket.data.userId = userId || null;
  socket.data.role = role || "guest";
  next();
});

// ─── Socket Events ────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  const { userId, visitorId, role: userRole } = socket.data;

  // ── Track authenticated users ──────────────────────────────────────────
  if (userId) {
    if (!activeUsers.has(userId)) {
      activeUsers.set(userId, new Set());
      io.emit("user-online", { userId });
      console.log(`User online: ${userId}`);
    }
    activeUsers.get(userId).add(socket.id);
  }

  // ── Track all visitors (authenticated + guest) ─────────────────────────
  if (!onlineVisitors.has(visitorId)) {
    onlineVisitors.set(visitorId, new Set());
  }
  onlineVisitors.get(visitorId).add(socket.id);
  broadcastOnlineCount();

  console.log(
    `Connected: visitorId=${visitorId} userId=${userId ?? "guest"} role=${userRole} socketId=${socket.id}`,
  );

  // ── Ticket room events ─────────────────────────────────────────────────

  socket.on("join-ticket", (ticketId) => {
    socket.join(`ticket:${ticketId}`);
    if (!ticketRooms.has(ticketId)) {
      ticketRooms.set(ticketId, new Set());
    }
    ticketRooms.get(ticketId).add(socket.id);
    console.log(`User ${userId ?? visitorId} joined ticket:${ticketId}`);
  });

  socket.on("leave-ticket", (ticketId) => {
    socket.leave(`ticket:${ticketId}`);
    if (ticketRooms.has(ticketId)) {
      ticketRooms.get(ticketId).delete(socket.id);
    }
    console.log(`User ${userId ?? visitorId} left ticket:${ticketId}`);
  });

  socket.on("send-message", (data) => {
    const { ticketId, message } = data;
    socket.to(`ticket:${ticketId}`).emit("new-message", { ticketId, message });
    console.log(`Message sent in ticket:${ticketId}`);
  });

  socket.on("typing", (data) => {
    const { ticketId, isTyping } = data;
    socket
      .to(`ticket:${ticketId}`)
      .emit("user-typing", { ticketId, userId, isTyping });
  });

  socket.on("ticket-updated", (data) => {
    const { ticketId, updates } = data;
    socket
      .to(`ticket:${ticketId}`)
      .emit("ticket-status-changed", { ticketId, updates });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────

  socket.on("disconnect", () => {
    // Remove from authenticated users
    if (userId && activeUsers.has(userId)) {
      const userSockets = activeUsers.get(userId);
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        activeUsers.delete(userId);
        io.emit("user-offline", { userId });
        console.log(`User offline: ${userId}`);
      }
    }

    // Remove from visitors
    if (onlineVisitors.has(visitorId)) {
      const visitorSockets = onlineVisitors.get(visitorId);
      visitorSockets.delete(socket.id);
      if (visitorSockets.size === 0) {
        onlineVisitors.delete(visitorId);
      }
    }
    broadcastOnlineCount();

    // Remove from ticket rooms
    for (const [ticketId, sockets] of ticketRooms.entries()) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        ticketRooms.delete(ticketId);
      }
    }

    console.log(`Disconnected: socketId=${socket.id} visitorId=${visitorId}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
  console.log(`CORS origin: ${CORS_ORIGIN}`);
});
