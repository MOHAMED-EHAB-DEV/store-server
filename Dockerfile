# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set the working directory
WORKDIR /app

# Copy package.json to the working directory
COPY package.json ./

# Install dependencies
# Note: ignoring bun.lock as we are using npm in this standard node image.
# If you prefer to use bun, you'd need a bun image or install bun here.
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 7860

# Define environment variables with default values (can be overridden at runtime)
# ENV SOCKET_PORT=3001
# ENV JWT_SECRET=fffff
# ENV NEXT_PUBLIC_APP_URL=http://localhost:3000

# Start the application
CMD ["npm", "start"]
