
import Server from 'socket.io';


let io = null;

export function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: 'http://localhost:5173', methods: ['GET', 'POST'] },
  });
  return io;
}

export function getIO() {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call init() first.');
  }
  return io;
}

