/**
 * ============================================================================
 * service/agentService.js  —  THE HTTP HANDLERS
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Sits between Express (the transport) and the agent loop (the brain).
 * It does three things and NOTHING else:
 *
 *   1. validate the incoming request
 *   2. fetch-or-create the session
 *   3. call run() and send back the reply
 *
 * WHY IT'S SEPARATE FROM THE ROUTER
 * ---------------------------------
 * `router.js` should only know about URLs and status codes. `agentService`
 * knows about sessions and the agent. Keeping them apart means you can add a
 * Socket.IO entry point or a CLI runner later that reuses this exact logic
 * without copying it out of an Express handler.
 *
 * ---------------------------------------------------------------------------
 * THE TRY/CATCH THAT SAVES THE SERVER
 * ---------------------------------------------------------------------------
 * `run()` is async. If it rejects and nothing catches it, Node raises an
 * *unhandled rejection* — and on modern Node that TERMINATES THE PROCESS.
 * You saw this earlier: one bad API call killed your server twice.
 *
 * The rule: every async Express handler MUST have a try/catch that responds
 * with a 500 instead of letting the error escape.
 * ===========================================================================
 */

import { run } from '../harness/agentic_loop.js';
import {
  createSession,
  getSession,
  touchSession,
  deleteSession,
  listSessions,
} from './sessionStore.js';
import { getIO } from '../socket/socket.js';

/**
 * Build the Socket.IO event target for a session.
 *
 * We emit into a *room* named after the session id, so events for one
 * conversation never leak into another user's browser tab.
 *
 * Returns a no-op function if Socket.IO isn't up — that keeps `run()`
 * usable in scripts/tests where there's no websocket at all.
 */
function makeEmitter(sessionId) {
  return (event, payload) => {
    try {
      getIO().to(roomName(sessionId)).emit(event, payload);
    } catch {
      // Socket not initialised: silently drop. Progress reporting is a
      // nice-to-have, never a reason to fail the actual request.
    }
  };
}

/** Rooms are just named strings in Socket.IO. Prefix avoids collisions. */
export function roomName(sessionId) {
  return `session:${sessionId}`;
}

// ===========================================================================
// POST /api/session  ->  create a session (and its sandbox)
// ===========================================================================
export async function createSessionHandler(req, res) {
  try {
    const session = await createSession();
    res.status(201).json({
      sessionId: session.id,
      cwd: session.sandbox.cwd,
      message: 'Session created. Connect Socket.IO and join the room to receive agent events.',
    });
  } catch (err) {
    console.error('[createSession]', err);
    res.status(500).json({ error: err.message });
  }
}

// ===========================================================================
// GET /api/session  ->  list sessions (debugging aid)
// ===========================================================================
export async function listSessionsHandler(req, res) {
  res.json({ sessions: listSessions() });
}

// ===========================================================================
// DELETE /api/session/:id  ->  destroy a session and its workspace
// ===========================================================================
export async function deleteSessionHandler(req, res) {
  try {
    const ok = await deleteSession(req.params.id);
    if (!ok) return res.status(404).json({ error: 'session not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[deleteSession]', err);
    res.status(500).json({ error: err.message });
  }
}

// ===========================================================================
// POST /api/send  ->  run the agent on one user message
// ===========================================================================
/**
 * Request body:
 *   { "sessionId": "optional-uuid", "message": "please read main.js" }
 *
 * Response body:
 *   { "sessionId": "...", "reply": "...", "iterations": n }
 *
 * NOTE: this request can take SECONDS (the agent may run 10 tools). That's
 * expected. If you later need a snappier feel, keep this endpoint and add
 * streaming over Socket.IO — the events are already being emitted.
 */
export async function agentStart(req, res) {
  try {
    const message = req.body?.message;

    // (1) VALIDATE — reject early with a helpful message rather than letting
    //     the LLM receive `undefined` and burn a round-trip on a 400.
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({
        error: 'Body must include a non-empty "message" field.',
        example: { message: 'list the files here' },
      });
    }

    // (2) SESSION — reuse the one the client named, or start a fresh one.
    let session = getSession(req.body.sessionId);

    if (!session && req.body.sessionId) {
      // The client thinks it has a session but it expired (or never existed).
      // Be explicit: silently creating a new one would make the client's
      // socket room and our session diverge, and events would go nowhere.
      return res.status(404).json({
        error: `Session ${req.body.sessionId} not found. It may have expired.`,
        hint: 'POST /api/session to create a new one.',
      });
    }

    if (!session) {
      session = await createSession();
    }

    touchSession(session.id);

    // (3) RUN THE AGENT.
    // `makeEmitter` forwards every progress event into the Socket.IO room
    // the client joined, so the UI can show tool calls as they happen.
    const reply = await run(session, message.trim(), makeEmitter(session.id));

    res.json({
      sessionId: session.id,
      reply,
      cwd: session.sandbox.cwd,
      // Handy for debugging: how many turns of history this session has now.
      messageCount: session.messages.length,
    });
  } catch (err) {
    // The catch-all that keeps the process alive. See the note at the top.
    console.error('[agentStart] FAILED:', err);
    res.status(500).json({
      error: err.message,
      // Surface the provider code when there is one — "401 invalid key" is
      // far more actionable than "Internal Server Error".
      code: err.code ?? null,
      type: err.type ?? null,
    });
  }
}
