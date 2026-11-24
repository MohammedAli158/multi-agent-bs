/**
 * ============================================================================
 * sandbox/sandbox_setup.js  —  CREATES AND DESTROYS A SESSION'S SANDBOX
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Gives every conversation its own private folder on disk:
 *
 *     createSandbox()  ->  /tmp/agent-sandboxes/<uuid>/
 *     destroySandbox() ->  deletes that folder
 *
 * WHY ONE FOLDER PER SESSION?
 * ---------------------------
 * Two users (or two conversations) must never see each other's files. The
 * folder IS the isolation boundary. It's also the unit we clean up: when a
 * session dies, one recursive delete reclaims everything it created.
 *
 * ---------------------------------------------------------------------------
 * THE SWAPPABLE INTERFACE  <-- IMPORTANT IF YOU LATER ADD DOCKER
 * ---------------------------------------------------------------------------
 * `createSandbox()` returns an OBJECT with a fixed shape:
 *
 *     {
 *       id,             // unique string
 *       cwd,            // absolute path to the workspace
 *       exec(opts),     // run a command INSIDE this sandbox
 *       destroy(),      // tear it down
 *     }
 *
 * Every tool in the codebase only ever talks to this shape. So to move to
 * Docker later you write a NEW sandbox_setup.js where `exec()` calls
 * `docker exec` instead of child_process — and NOTHING ELSE CHANGES.
 * That's the whole point of putting this behind an interface.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { execCommand, formatExecResult } from './sandbox_execute.js';

/**
 * Create a fresh, empty sandbox for one session.
 *
 * @returns {Promise<object>} the sandbox handle described above
 */
export async function createSandbox() {
  // crypto.randomUUID() gives something like "3f1a...-...-...". It's collision
  // proof for our purposes and it's built into Node — no dependency needed.
  const id = crypto.randomUUID();

  // Path join, not string concat: handles / vs \ correctly on every OS.
  const cwd = path.join(config.sandboxRoot, id);

  // recursive:true = create parents if missing (like `mkdir -p`).
  await fs.mkdir(cwd, { recursive: true });

  // A tiny marker file so we can tell our folders apart from random junk
  // in the temp dir, and so a stray cleanup sweep won't delete other apps'
  // data. Belt and braces.
  await fs.writeFile(
    path.join(cwd, '.agent-sandbox.json'),
    JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  console.log(`[sandbox] created ${id} -> ${cwd}`);

  return {
    id,
    cwd,

    /**
     * Run a command inside THIS sandbox.
     * The only thing "inside" means right now is `cwd` — see the interface
     * note above for how that becomes a real container later.
     *
     * @param {string} command
     * @param {object} [opts]  { timeoutMs, maxOutputBytes }
     * @returns {Promise<object>} raw exec result
     */
    async exec(command, opts = {}) {
      return execCommand({ command, cwd, ...opts });
    },

    /**
     * Like exec(), but returns a formatted STRING ready to be fed to the LLM.
     * Convenience so tools don't each re-implement the formatting.
     */
    async run(command, opts = {}) {
      const result = await execCommand({ command, cwd, ...opts });
      return formatExecResult(result);
    },

    /** Tear down. Safe to call twice (the second call is a no-op). */
    async destroy() {
      try {
        // recursive + force: delete the folder even if it's non-empty,
        // and don't explode if it's already gone.
        await fs.rm(cwd, { recursive: true, force: true });
        console.log(`[sandbox] destroyed ${id}`);
      } catch (err) {
        // Never let cleanup failure crash the server — log and move on.
        console.error(`[sandbox] failed to destroy ${id}:`, err.message);
      }
    },
  };
}

/**
 * Remove EVERY sandbox we ever created. Used on process shutdown so a Ctrl+C
 * doesn't leave hundreds of folders rotting in the temp directory.
 */
export async function destroyAllSandboxes() {
  try {
    const entries = await fs.readdir(config.sandboxRoot).catch(() => []);

    // Only delete folders that carry our marker file — never blindly wipe a
    // shared temp directory, because something else might live there too.
    await Promise.all(
      entries.map(async (name) => {
        const dir = path.join(config.sandboxRoot, name);
        const marker = path.join(dir, '.agent-sandbox.json');
        if (await fs.access(marker).then(() => true).catch(() => false)) {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }),
    );

    if (entries.length) {
      console.log(`[sandbox] cleaned up ${entries.length} sandbox folder(s)`);
    }
  } catch (err) {
    console.error('[sandbox] cleanup error:', err.message);
  }
}
