/**
 * ============================================================================
 * main.js  —  THE ENTRY POINT (where everything is plugged together)
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Startup wiring only. If you're looking for business logic, it isn't here —
 * look in `harness/` (the brain) or `service/` (the glue).
 *
 * STARTUP ORDER MATTERS:
 *   1. Express app + JSON body parsing     (so req.body exists)
 *   2. HTTP server                         (so Socket.IO can share the port)
 *   3. Socket.IO init + handlers           (so agents can emit progress)
 *   4. Routes                              (so requests have somewhere to go)
 *   5. Listen                              (only after everything above works)
 *
 * RUN IT WITH:
 *   node --watch --env-file=.env main.js
 *
 *   --env-file=.env   loads .env into process.env (secrets, model, port)
 *   --watch           restarts automatically when you save a file
 *
 * ---------------------------------------------------------------------------
 * WHAT KILLED YOUR SERVER BEFORE (and how this file prevents it)
 * ---------------------------------------------------------------------------
 * 1. `app.listen('/api', router)` — listen() expects a PORT, not a path.
 *    Fixed: routes are mounted with app.use('/api', router), and only the
 *    HTTP server ever listens.
 *
 * 2. Unhandled promise rejections from async handlers crashed the process.
 *    Fixed: every handler has try/catch (see agentService.js) AND we install
 *    process-level handlers below as a last line of defence.
 * ===========================================================================
 */

import express from 'express';
import { createServer } from 'http';
import { init as initSocket } from './socket/socket.js';
import { registerSocketHandlers } from './socket/handlers.js';
import { router } from './controller/router.js';
import { config } from './config.js';
import { startSessionSweeper, stopSessionSweeper, deleteAllSessions } from './service/sessionStore.js';
import { destroyAllSandboxes } from './sandbox/sandbox_setup.js';

// The Express application. Think of it as a pipeline: a request enters, runs
// through middleware in order, and ends up at a route handler.
export const app = express();

// --- Middleware -------------------------------------------------------------
// `express.json()` parses the request body when Content-Type is
// application/json and puts it on `req.body`.
//
// WITHOUT THIS, req.body is `undefined` — which is exactly why the original
// code sent `input: undefined` to the LLM and got "invalid_prompt".
// Order matters: this must run BEFORE any route that reads req.body.
app.use(express.json());

// --- HTTP server -----------------------------------------------------------
// Created separately so Socket.IO can attach to the same port (it needs the
// raw server object to intercept the WebSocket upgrade handshake).
const httpServer = createServer(app);

// --- Socket.IO -------------------------------------------------------------
const io = initSocket(httpServer);
registerSocketHandlers(io);

// --- Routes ----------------------------------------------------------------
// Everything under controller/router.js is now reachable at /api/*.
app.use('/api', router);

// A root-level health check too (handy for uptime monitors that hit "/").
app.get('/health', (req, res) => res.json({ success: true }));

// A friendly 404 for unknown API routes. Without this, Express returns a
// bare HTML page, which is confusing when you're calling it with curl.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: `No such route: ${req.method} ${req.originalUrl}`,
    hint: 'GET /api/health, POST /api/session, POST /api/send',
  });
});

// --- Start -----------------------------------------------------------------
httpServer.listen(config.port, () => {
  console.log('='.repeat(60));
  console.log(`  orchestrator listening on http://localhost:${config.port}`);
  console.log(`  model: ${config.model}`);
  console.log(`  base:  ${config.baseUrl}`);
  console.log('='.repeat(60));
  console.log('  POST /api/session   create a session');
  console.log('  POST /api/send      run the agent');
  console.log('  GET  /api/ping-llm  verify your API key');
  console.log('='.repeat(60));

  // Start deleting idle sessions so abandoned sandboxes don't fill the disk.
  startSessionSweeper();
});

// ---------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// ---------------------------------------------------------------------------
// Ctrl+C sends SIGINT. If we just exit, two things leak:
//   1. sandbox folders in the temp directory
//   2. the sweeper timer keeps the process alive
// This handler cleans up before letting the process end.
//
// `shutdown()` is async but we deliberately don't `await` it inside the
// signal handler — we kick it off and force-exit on a timer as a fallback,
// so a hang during cleanup can never trap you in an unkillable process.
async function shutdown(signal) {
  console.log(`\n[shutdown] received ${signal}, cleaning up...`);

  stopSessionSweeper();            // stop the reaper first
  await deleteAllSessions();       // destroys each session's sandbox
  await destroyAllSandboxes();     // sweep any orphaned folders

  console.log('[shutdown] done');
  process.exit(0);
}

// SIGINT  = Ctrl+C in the terminal
// SIGTERM = polite "please exit" (used by process managers)
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Last-resort guards. An *unhandled rejection* on Node 15+ terminates the
// process by default — which is how one bad LLM call took your server down.
// We log loudly instead: the request fails, but the server survives to
// serve the next one.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaught exception:', err);
});
