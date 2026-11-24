/**
 * ============================================================================
 * socket/socket.js  —  WEBSOCKET SERVER SETUP
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Creates the Socket.IO server and, crucially, keeps it in a module-level
 * variable so OTHER files can emit events without threading `io` through
 * every function call.
 *
 * WHY A SINGLETON?
 * ----------------
 * `agentService.js` needs to emit progress events, but it's called from an
 * Express handler that has no idea a socket server exists. Exporting
 * `getIO()` lets any module reach the same instance. The trade-off of
 * singletons (hidden coupling) is worth it here: it keeps the call sites
 * clean.
 *
 * The guard in `getIO()` — throwing if init() wasn't called — turns a
 * confusing "cannot read property of undefined" into a message that tells
 * you exactly what you forgot to do.
 */

import { Server } from 'socket.io';

/** @type {import('socket.io').Server|null} */
let io = null;

/**
 * Create the Socket.IO server on top of the existing HTTP server.
 *
 * WHY AN EXISTING HTTP SERVER? Socket.IO upgrades a normal HTTP request via
 * a WebSocket handshake, so it must share the same port as Express. One port
 * = one firewall rule = one URL for the client to remember.
 *
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
export function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      // The browser will be running a dev frontend (Vite defaults to 5173).
      // Without this, the browser blocks the socket as a cross-origin request.
      origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
      methods: ['GET', 'POST'],
    },
    // Cap payload size: tool results can be large, but 5MB is plenty for
    // progress events and stops a malicious client from flooding us.
    maxHttpBufferSize: 5 * 1024 * 1024,
  });
  return io;
}

/**
 * Get the initialised server, or explain what's wrong.
 * @returns {import('socket.io').Server}
 */
export function getIO() {
  if (!io) {
    throw new Error('Socket.IO not initialised. Call init() first (see main.js).');
  }
  return io;
}
