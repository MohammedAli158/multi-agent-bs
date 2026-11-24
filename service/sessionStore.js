/**
 * ============================================================================
 * service/sessionStore.js  —  THE IN-MEMORY DATABASE
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Keeps a Map of every live session:
 *
 *     sessionId -> {
 *       id, sandbox, messages[], createdAt, lastUsed
 *     }
 *
 * A "session" is one conversation + one sandbox + one file workspace.
 * Everything that must survive between HTTP requests lives here.
 *
 * ---------------------------------------------------------------------------
 * WHY IN-MEMORY (AND WHEN THAT BREAKS)
 * ---------------------------------------------------------------------------
 * A plain JavaScript Map is perfect while you run ONE process. It's fast,
 * has zero setup, and garbage collection cleans it when you exit.
 *
 * It breaks the moment you:
 *   - run more than one server instance (each has its own Map!)
 *   - restart the process (all conversations vanish)
 *
 * The fix, when you get there, is to swap this file for Redis/Postgres.
 * Nothing else in the codebase knows how sessions are stored — they just
 * call createSession/getSession — so it's a one-file change. That's why all
 * access goes through this module instead of a bare Map scattered around.
 * ===========================================================================
 */

import crypto from 'node:crypto';
import { createSandbox } from '../sandbox/sandbox_setup.js';
import { config } from '../config.js';

/** @type {Map<string, object>} sessionId -> session */
const sessions = new Map();

// ---------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------

/**
 * Create a brand new session and its private sandbox.
 * @returns {Promise<object>} the new session
 */
export async function createSession() {
  const id = crypto.randomUUID();

  // The sandbox owns the workspace folder. If THIS fails, no session is
  // registered — we don't want half-created entries in the map.
  const sandbox = await createSandbox();

  const now = Date.now();
  const session = {
    id,
    sandbox,
    // The conversation history the LLM sees. Starts empty; the system prompt
    // is prepended at request time by agentic_loop.js rather than stored here
    // (so it can be edited without invalidating saved sessions).
    messages: [],
    createdAt: now,
    lastUsed: now,
  };

  sessions.set(id, session);
  console.log(`[session] created ${id} (total: ${sessions.size})`);
  return session;
}

/**
 * Look up a session, or return null.
 * NEVER throws for a missing id — callers decide whether that's a 404 or a
 * "create one for me".
 *
 * @param {string} id
 * @returns {object|null}
 */
export function getSession(id) {
  if (!id || typeof id !== 'string') return null;
  return sessions.get(id) ?? null;
}

/**
 * Update `lastUsed` so the reaper doesn't kill an active session.
 * Call this on EVERY request that touches the session.
 */
export function touchSession(id) {
  const s = sessions.get(id);
  if (s) s.lastUsed = Date.now();
  return s;
}

/**
 * Destroy one session: kill its sandbox (deleting the workspace folder) and
 * forget the history. Safe to call with an unknown id.
 */
export async function deleteSession(id) {
  const session = sessions.get(id);
  if (!session) return false;

  // Remove from the map FIRST. If destroy() throws, we've already stopped
  // handing this session to new requests — better than the reverse, which
  // would leave a "live" session pointing at a dead sandbox.
  sessions.delete(id);

  if (session.sandbox?.destroy) {
    await session.sandbox.destroy();
  }

  console.log(`[session] deleted ${id} (total: ${sessions.size})`);
  return true;
}

/** Introspection helper for the API — never expose `messages` here. */
export function listSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    cwd: s.sandbox?.cwd,
    messageCount: s.messages.length,
    createdAt: s.createdAt,
    lastUsed: s.lastUsed,
    ageMs: Date.now() - s.createdAt,
    idleMs: Date.now() - s.lastUsed,
  }));
}

// ---------------------------------------------------------------------------
// THE REAPER  (prevents leaking disk space forever)
// ---------------------------------------------------------------------------

let sweeperHandle = null;

/**
 * Start the background job that deletes sessions nobody has used for
 * `config.sessionTtlMs`. Call once at startup.
 *
 * WHY IT MATTERS: without this, every abandoned conversation leaves a folder
 * in your temp directory until you reboot. Over a few days that's megabytes
 * of orphaned source files nobody will ever read again.
 */
export function startSessionSweeper() {
  if (sweeperHandle) return; // idempotent — don't start two timers

  sweeperHandle = setInterval(async () => {
    const cutoff = Date.now() - config.sessionTtlMs;
    const expired = [...sessions.values()].filter((s) => s.lastUsed < cutoff);

    if (expired.length === 0) return;

    console.log(`[session] reaping ${expired.length} idle session(s)`);
    for (const s of expired) {
      // await sequentially: avoids hammering the disk with N simultaneous
      // recursive deletes if someone left 50 sessions open.
      await deleteSession(s.id);
    }
  }, config.sweepIntervalMs);

  // `unref()` tells Node "this timer should not keep the process alive".
  // Without it, a plain `node main.js` (no server holding the event loop)
  // would never exit because the reaper is always pending.
  sweeperHandle.unref?.();
}

/** Stop the reaper (used during graceful shutdown). */
export function stopSessionSweeper() {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}

/** Delete everything — used on SIGINT/SIGTERM shutdown. */
export async function deleteAllSessions() {
  const ids = [...sessions.keys()];
  for (const id of ids) {
    await deleteSession(id);
  }
}
