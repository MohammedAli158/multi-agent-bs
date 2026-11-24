/**
 * ============================================================================
 * config.js  —  THE SINGLE SOURCE OF TRUTH FOR EVERY SETTING
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Scattering numbers like "120000" (2 minute timeout) across 10 files makes a
 * project impossible to tune. Every knob in the whole system lives here, and
 * every other file imports from here.
 *
 * HOW VALUES GET IN
 * -----------------
 * We start node with:
 *     node --watch --env-file=.env main.js
 * `--env-file` reads the .env file and puts every line into `process.env`.
 * So `process.env.MODEL` is whatever you typed after `MODEL=` in .env.
 *
 * The `|| default` pattern (called "fallback") means:
 *     "use the env var if it exists, otherwise use this default value".
 * That way the app still boots even if you forget to define something.
 */

import os from 'node:os';
import path from 'node:path';

export const config = {
  // ---------------------------------------------------------------------------
  // HTTP SERVER
  // ---------------------------------------------------------------------------
  // The port our Express server listens on. Port 3000 is the classic dev port.
  port: process.env.PORT || 3000,

  // ---------------------------------------------------------------------------
  // LLM PROVIDER  (OpenRouter, in your case)
  // ---------------------------------------------------------------------------
  // The OpenAI SDK lets you point it at ANY provider just by changing baseURL.
  // OpenRouter speaks the exact same API as OpenAI, so one SDK works for both.
  //
  // If you ever switch back to real OpenAI, set this to:
  //     https://api.openai.com/v1
  baseUrl: process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1',

  // Your secret key. NEVER hardcode this. NEVER log it. NEVER send it to a
  // sandbox. It lives only in .env (which is git-ignored) and in process.env.
  apiKey: process.env.OPENAI_API_KEY,

  // Which model to talk to.
  // NOTE: `recraft/...` is an IMAGE model — it cannot do tool calling.
  // You need a TEXT model that supports function calling.
  model: process.env.MODEL || 'openai/gpt-4o-mini',

  // ---------------------------------------------------------------------------
  // AGENT LOOP SAFETY LIMITS
  // ---------------------------------------------------------------------------
  // The agent loop can theoretically run forever: the model calls a tool, gets
  // a result, calls another tool, ... To guarantee it always terminates we
  // hard-stop after this many model round-trips.
  maxIterations: 25,

  // Upper bound on how many tokens a single model reply may produce.
  maxOutputTokens: 2000,

  // ---------------------------------------------------------------------------
  // SANDBOX (command execution) LIMITS
  // ---------------------------------------------------------------------------
  // How long a single shell command may run before we kill it.
  // If the agent runs `npm install` on a huge project this might be too short;
  // if it runs an infinite loop, this is what saves you.
  defaultTimeoutMs: 120_000, // 120 seconds

  // Hard cap on how much output (stdout+stderr) we keep from one command.
  // Without this, a command like `dir /s C:\` could eat all your RAM.
  maxOutputBytes: 100_000, // ~100 KB

  // ---------------------------------------------------------------------------
  // SESSION LIFETIME
  // ---------------------------------------------------------------------------
  // How long a session (and its workspace folder) may sit idle before we throw
  // it away. This stops thousands of abandoned sessions from filling the disk.
  sessionTtlMs: 30 * 60 * 1000, // 30 minutes of inactivity

  // How often the background "reaper" wakes up to check for idle sessions.
  sweepIntervalMs: 60 * 1000, // every 1 minute

  // ---------------------------------------------------------------------------
  // FILESYSTEM LAYOUT
  // ---------------------------------------------------------------------------
  // Every session gets its own private folder. We put them all under one root
  // so cleanup is a single `rm -rf` away.
  sandboxRoot: path.join(os.tmpdir(), 'agent-sandboxes'),

  // ---------------------------------------------------------------------------
  // FUTURE-PROOFING (used when you swap in a real container later)
  // ---------------------------------------------------------------------------
  // These do nothing in the child_process implementation, but keeping them here
  // means switching to Docker later only requires editing sandbox_setup.js —
  // nothing else in the codebase changes.
  sandboxImage: process.env.SANDBOX_IMAGE || 'node:20-bookworm-slim',
  sandboxMemoryMb: 512,
  sandboxCpuMs: 1000, // cpu quota per 100ms window
};
