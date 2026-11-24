/**
 * ============================================================================
 * controller/router.js  —  URL -> HANDLER MAPPING
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Declares the HTTP API. That's it — no business logic lives here.
 *
 * DESIGN RULE: a route file should be readable like a table of contents.
 * If you find yourself writing `if` statements or try/catch in here, the
 * logic probably belongs in `service/` instead.
 *
 * ---------------------------------------------------------------------------
 * THE API SURFACE
 * ---------------------------------------------------------------------------
 *   POST   /api/session        create a session + sandbox     -> { sessionId }
 *   GET    /api/session        list sessions (debug)
 *   DELETE /api/session/:id    destroy a session + workspace
 *   POST   /api/send           run the agent                  -> { reply }
 *   GET    /health             liveness probe
 * ---------------------------------------------------------------------------
 *
 * WHY TWO WAYS IN (HTTP + Socket.IO)?
 *   HTTP is request/response — perfect for "run this and give me the answer".
 *   Socket.IO is push — perfect for "tell me about tool calls as they happen".
 *   The client does BOTH: POST /api/send to start work, socket room to watch it.
 */

import express from 'express';
import {
  createSessionHandler,
  listSessionsHandler,
  deleteSessionHandler,
  agentStart,
} from '../service/agentService.js';
import { roomName } from '../service/agentService.js';
import { pingLLM } from '../harness/llm_client.js';

// A Router is a modular route container. main.js attaches it with
// app.use('/api', router), so every path here is prefixed with /api.
export const router = express.Router();

// --- Health -----------------------------------------------------------------
// Kept on /api/health (and also exposed at /health from main.js).
// `pingLLM` proves the API key + base URL actually work end-to-end, which is
// the fastest way to answer "is my key working?".
router.get('/health', async (req, res) => {
  res.json({ success: true, service: 'orchestrator', ts: Date.now() });
});

router.get('/ping-llm', async (req, res) => {
  try {
    const reply = await pingLLM();
    res.json({ ok: true, reply });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message, code: err.code ?? null });
  }
});

// --- Sessions ---------------------------------------------------------------
router.post('/session', createSessionHandler);
router.get('/session', listSessionsHandler);
router.delete('/session/:id', deleteSessionHandler);

// --- Agent ------------------------------------------------------------------
// The main event. Body: { sessionId?, message }
router.post('/send', agentStart);

// Exported for socket/handlers.js so both transports agree on room naming.
export { roomName };
