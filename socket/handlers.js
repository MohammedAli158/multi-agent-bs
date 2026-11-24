/**
 * ============================================================================
 * socket/handlers.js  —  WHAT A BROWSER SOCKET CAN SAY TO US
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Wires up the Socket.IO connection lifecycle:
 *
 *   client emits "join"   ->  server adds them to a room
 *   server emits events   ->  ONLY clients in that room receive them
 *
 * ---------------------------------------------------------------------------
 * WHY ROOMS?
 * ---------------------------------------------------------------------------
 * Without rooms, every connected browser would receive every agent event
 * from every session — user A would watch user B's tool calls scroll by.
 *
 * Socket.IO "rooms" are named groups. We name them `session:<id>` (see
 * roomName() in agentService.js) and only emit into that room. Joining is
 * how a client says "I want updates for THIS conversation".
 *
 * SECURITY NOTE: we do NOT verify that the socket "owns" the session. In a
 * real multi-user deployment you'd require auth on connection and check
 * session ownership before joining a room — otherwise anyone who can guess a
 * session UUID can eavesdrop on it. Session ids are random UUIDs, which is
 * decent, but not an authorization system.
 * ===========================================================================
 */

import { getIO } from './socket.js';
import { roomName } from '../service/agentService.js';
import { getSession, touchSession, deleteSession } from '../service/sessionStore.js';

/**
 * Register all socket event handlers. Called once from main.js.
 *
 * @param {import('socket.io').Server} io
 */
export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`[socket] connected ${socket.id}`);

    // ---------------------------------------------------------------------
    // "join" — subscribe this socket to a session's event room.
    // Payload: { sessionId: "uuid" }
    // ---------------------------------------------------------------------
    socket.on('join', ({ sessionId } = {}) => {
      // Validate before joining. `join` with an undefined room name would
      // silently put the socket in a room literally named "undefined".
      const session = getSession(sessionId);
      if (!session) {
        // Tell the caller WHY it failed so the UI can show something useful
        // instead of just "no events ever arrived".
        socket.emit('error', {
          message: `Cannot join: session ${sessionId ?? '(missing)'} not found or expired.`,
        });
        return;
      }

      const room = roomName(sessionId);
      socket.join(room);
      touchSession(sessionId);

      console.log(`[socket] ${socket.id} joined ${room}`);
      socket.emit('joined', {
        sessionId,
        cwd: session.sandbox.cwd,
        messageCount: session.messages.length,
      });
    });

    // ---------------------------------------------------------------------
    // "leave" — unsubscribe. Useful when a client switches conversations
    // without disconnecting.
    // ---------------------------------------------------------------------
    socket.on('leave', ({ sessionId } = {}) => {
      if (!sessionId) return;
      socket.leave(roomName(sessionId));
      console.log(`[socket] ${socket.id} left session ${sessionId}`);
    });

    // ---------------------------------------------------------------------
    // "destroy_session" — lets the UI tear down a session (and free its
    // workspace folder) without making a separate HTTP call.
    // ---------------------------------------------------------------------
    socket.on('destroy_session', async ({ sessionId } = {}) => {
      try {
        const ok = await deleteSession(sessionId);
        // Announce it to everyone still in the room BEFORE they get kicked.
        io.to(roomName(sessionId)).emit('session_destroyed', { sessionId });
        socket.emit('destroy_result', { sessionId, ok });
      } catch (err) {
        socket.emit('error', { message: `Failed to destroy session: ${err.message}` });
      }
    });

    // ---------------------------------------------------------------------
    // Disconnect — purely informational. Note we do NOT destroy the session
    // here: a page refresh would then wipe the user's conversation. Instead
    // the TTL sweeper in sessionStore.js cleans up abandoned sessions.
    // ---------------------------------------------------------------------
    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnected ${socket.id} (${reason})`);
    });
  });
}
