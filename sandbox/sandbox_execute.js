/**
 * ============================================================================
 * sandbox/sandbox_execute.js  —  RUNS ONE SHELL COMMAND (and supervises it)
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Takes a raw shell command string and a working directory, spawns it as a
 * real OS process, watches it, and reports back:
 *
 *     { stdout, stderr, exitCode, timedOut, durationMs }
 *
 * THE THREE BAD THINGS THIS FILE PROTECTS AGAINST
 * -----------------------------------------------
 *  1. HANGING FOREVER  -> we kill it after `timeoutMs`.
 *  2. SPAMMING OUTPUT  -> we stop collecting after `maxOutputBytes`.
 *  3. LEAKING SECRETS  -> the child gets a scrubbed environment (see
 *                         security.js buildSandboxEnv).
 *
 * WHY `spawn` AND NOT `exec`
 * --------------------------
 * `exec` buffers the ENTIRE output in memory before giving it to you — one
 * noisy command and you're swapping. `spawn` gives us the output as a stream,
 * so we can count bytes as they arrive and cut it off. That's the difference
 * between a tool that survives a `dir /s C:\` and one that doesn't.
 */

import { spawn } from 'node:child_process';
import { checkCommand, buildSandboxEnv, truncateOutput, SecurityError } from './security.js';
import { config } from '../config.js';

/**
 * Execute a shell command inside a workspace.
 *
 * @param {object}   opts
 * @param {string}   opts.command        the command line to run
 * @param {string}   opts.cwd            absolute path to the session workspace
 * @param {number}  [opts.timeoutMs]     kill after this many ms
 * @param {number}  [opts.maxOutputBytes] cap collected output
 * @returns {Promise<object>} stdout, stderr, exitCode, timedOut, durationMs
 */
export function execCommand({
  command,
  cwd,
  timeoutMs = config.defaultTimeoutMs,
  maxOutputBytes = config.maxOutputBytes,
}) {
  // (A) SECURITY GATE — refuse dangerous commands before we even spawn.
  // Throws SecurityError, which the caller turns into a tool result string
  // (see toolExecute.js) so the MODEL learns the rule instead of crashing.
  checkCommand(command);

  // (B) PERFORMANCE GATE — refuse output that's obviously too big to be useful.
  // A 200MB stdout would destroy the LLM's context window anyway.
  const collectedBytes = { stdout: 0, stderr: 0, truncated: false };

  return new Promise((resolve) => {
    const startedAt = Date.now();

    // `shell: true` means we hand the string to the platform shell
    // (cmd.exe on Windows, /bin/sh on Linux) so pipes, &&, > all work —
    // which is what users expect from a "shell" tool.
    //
    // IMPORTANT: because it goes through a shell, QUOTING IS YOUR FRIEND.
    // We pass the raw string on purpose: the agent composes commands, and
    // sanitising them would break legitimate things like `grep "foo bar"`.
    const child = spawn(command, {
      cwd,
      shell: true,
      env: buildSandboxEnv(),   // secrets stripped — see security.js
      stdio: ['ignore', 'pipe', 'pipe'], // no stdin: commands can't block on input
      windowsHide: true,        // don't pop console windows on Windows
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killedForSize = false;

    // ---- Attach a byte-limited reader to each stream -----------------------
    const attach = (stream, which) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        // Stop growing the string once we've hit the cap.
        if (collectedBytes[which] >= maxOutputBytes) {
          if (!killedForSize) {
            killedForSize = true;
            // Killing the child also stops it from producing more work.
            child.kill('SIGKILL');
          }
          return;
        }
        collectedBytes[which] += Buffer.byteLength(chunk, 'utf8');
        if (which === 'stdout') stdout += chunk;
        else stderr += chunk;

        if (collectedBytes[which] >= maxOutputBytes && !killedForSize) {
          killedForSize = true;
          child.kill('SIGKILL');
        }
      });
    };

    attach(child.stdout, 'stdout');
    attach(child.stderr, 'stderr');

    // ---- Timeout watchdog ---------------------------------------------------
    // We use setTimeout rather than the built-in `timeout` spawn option so we
    // can set a `timedOut` flag — the caller needs to KNOW the difference
    // between "command failed" and "command was killed for running too long".
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL'); // SIGKILL = "die now, no cleanup"
    }, timeoutMs);

    // ---- Teardown / settle --------------------------------------------------
    // 'close' fires after ALL stdio streams are done, so stdout/stderr are
    // complete by the time we resolve. 'error' covers "command not found".
    const settle = (exitCode, spawnError) => {
      clearTimeout(timer);

      const durationMs = Date.now() - startedAt;

      // Build a human/LLM-readable result. Notice we don't throw: a failing
      // command is a NORMAL, expected outcome of an agent's work. We return
      // it as data so the model can read the error and try something else.
      let finalStdout = truncateOutput(stdout, maxOutputBytes);
      let finalStderr = truncateOutput(stderr, maxOutputBytes);

      if (timedOut) {
        finalStderr += `\n[TIMEOUT] command killed after ${timeoutMs}ms`;
      }
      if (killedForSize) {
        finalStderr += `\n[OUTPUT LIMIT] output exceeded ${maxOutputBytes} bytes`;
      }
      if (spawnError) {
        finalStderr += `\n[SPAWN ERROR] ${spawnError.message}`;
      }

      resolve({
        stdout: finalStdout,
        stderr: finalStderr,
        exitCode: exitCode ?? -1,
        timedOut,
        durationMs,
      });
    };

    child.on('error', (err) => settle(-1, err));
    child.on('close', (code) => settle(code, null));
  });
}

/**
 * Convert an execCommand() result into a compact STRING.
 *
 * WHY A STRING? Because that's the shape a `tool` message in the
 * chat-completions API takes: `content` must be text. Keeping formatting
 * decisions here (rather than in the tool dispatcher) means every tool
 * returns a consistent, LLM-friendly shape.
 */
export function formatExecResult(result) {
  const parts = [];

  if (result.stdout) parts.push(`STDOUT:\n${result.stdout}`);
  if (result.stderr) parts.push(`STDERR:\n${result.stderr}`);

  parts.push(`EXIT CODE: ${result.exitCode}`);
  parts.push(`DURATION: ${result.durationMs}ms`);

  if (result.timedOut) parts.push('STATUS: TIMED OUT (killed by watchdog)');

  return parts.join('\n\n');
}

export { SecurityError };
