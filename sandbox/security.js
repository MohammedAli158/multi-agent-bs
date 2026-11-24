/**
 * ============================================================================
 * sandbox/security.js  —  THE BOUNCER
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Before any command runs or any file is touched, it passes through here.
 *
 * TWO JOBS:
 *   1. resolveSafePath()  -> makes sure a file path stays INSIDE the workspace
 *                            (stops `../../etc/passwd` style escapes)
 *   2. checkCommand()     -> rejects shell commands that look dangerous
 *
 * IMPORTANT HONESTY NOTE
 * ----------------------
 * This is a *deterrent*, not true isolation. A determined model (or attacker)
 * could obfuscate a command to slip past a regex. Real isolation requires a
 * container/VM, which is exactly what the `sandbox/` layer is designed to swap
 * in later. Think of this file as: "stop accidents, not adversaries".
 *
 * THE WHOLE POINT: every other file imports these two functions and must call
 * them. If you add a new tool, call resolveSafePath before touching disk.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// THROWN when something tries to escape or do something forbidden.
// We use a custom error class so we can spot "this was a security rejection"
// separately from "this was a random bug" when reading logs.
// ---------------------------------------------------------------------------
export class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityError';
    this.code = 'SECURITY_VIOLATION';
  }
}

// ===========================================================================
// PART 1 — PATH CONTAINMENT
// ===========================================================================

/**
 * Turn a user/agent supplied relative path into a safe absolute path that is
 * guaranteed to live inside `workspaceDir`.
 *
 * THE ATTACK WE'RE STOPPING:
 *   workspace = /tmp/agent-sandboxes/abc123
 *   agent asks for path = "../../../../Windows/System32/config/SAM"
 *   Naive join() would happily produce /Windows/System32/config/SAM
 *
 * HOW THE DEFENSE WORKS:
 *   1. Resolve everything to a normalised absolute path (this collapses `..`).
 *   2. Check the result STARTS WITH the workspace path.
 *   3. Also reject anything that is an absolute path pointing elsewhere, and
 *      reject Windows-specific trickery like `\\server\share` (UNC paths) and
 *      drive letters that aren't the workspace drive.
 *
 * @param {string} workspaceDir  absolute path to the session's private folder
 * @param {string} userPath      path supplied by the LLM or the HTTP client
 * @returns {Promise<string>}    the safe absolute path
 * @throws {SecurityError}       if the path escapes the workspace
 */
export async function resolveSafePath(workspaceDir, userPath) {
  if (typeof userPath !== 'string' || userPath.trim() === '') {
    throw new SecurityError('path must be a non-empty string');
  }

  const trimmed = userPath.trim();

  // Normalise the workspace once so comparisons are apples-to-apples.
  const workspace = path.resolve(workspaceDir);

  // A backslash-prefixed path on Windows is a UNC path (\\server\share) —
  // always reject, we never want network shares.
  if (trimmed.startsWith('\\\\')) {
    throw new SecurityError(`UNC/network paths are not allowed: ${trimmed}`);
  }

  // Reject a path that names a *different* drive letter (C:\ vs D:\).
  // path.isAbsolute("C:\\foo") === true on Windows.
  if (path.isAbsolute(trimmed)) {
    const resolvedAbsolute = path.resolve(trimmed);
    const inside = isInside(workspace, resolvedAbsolute);
    if (!inside) {
      throw new SecurityError(
        `absolute path outside workspace is not allowed: ${trimmed}`,
      );
    }
    return resolvedAbsolute;
  }

  // The normal case: a relative path like "src/index.js" or "../escape".
  // path.resolve(workspace, "../escape") collapses the `..` for us, which is
  // exactly what we want — then we verify where it landed.
  const resolved = path.resolve(workspace, trimmed);

  if (!isInside(workspace, resolved)) {
    throw new SecurityError(
      `path escapes the workspace sandbox: ${userPath} -> ${resolved}`,
    );
  }

  return resolved;
}

/**
 * Pure boolean helper: is `candidate` equal to `root` or nested under it?
 *
 * We append a path separator to the root before comparing so that
 *   root = "/tmp/abc"      (workspace)
 *   cand = "/tmp/abcdef"   (a SIBLING folder that merely shares a prefix!)
 * does NOT count as "inside". Without the separator, "/tmp/abc" is a prefix
 * of "/tmp/abcdef" and we'd wrongly allow it.
 */
function isInside(root, candidate) {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(rootWithSep);
}

/**
 * Convenience wrapper: resolve the path AND make sure the parent directory
 * exists (needed by write_file, which promises to create directories).
 */
export async function resolveSafePathForWrite(workspaceDir, userPath) {
  const safe = await resolveSafePath(workspaceDir, userPath);
  await fs.mkdir(path.dirname(safe), { recursive: true });
  return safe;
}

// ===========================================================================
// PART 2 — COMMAND BLOCKLIST
// ===========================================================================

/**
 * Each entry is a pair of: a regex to test against the command, and a human
 * readable reason. The reason is what the LLM (and you) will see, so it should
 * tell the model what NOT to do next rather than just saying "denied".
 *
 * WHY A LIST AND NOT A WHITELIST?
 *   A whitelist ("only these exact commands are legal") is much safer but
 *   makes the agent useless — it can't run `npm test`, `python foo.py`, etc.
 *   We use a blocklist of obviously-catastrophic patterns as a pragmatic
 *   middle ground. See the honesty note at the top of this file.
 */
const BLOCKED_COMMANDS = [
  // --- Deleting things you should never delete -----------------------------
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|$)/i,
    why: 'recursive delete of the filesystem root is forbidden' },
  { re: /\brm\s+.*\s+\/\*+\s*$/i,
    why: 'recursive delete of everything is forbidden' },
  { re: /\bformat\s+[a-z]:/i,
    why: 'formatting a disk is forbidden' },
  { re: /\bmkfs(\.|\b)/i,
    why: 'creating a filesystem is forbidden' },
  { re: /\bdiskpart\b/i,
    why: 'disk partitioning is forbidden' },

  // --- Windows-flavoured destruction ---------------------------------------
  { re: /\brd\s+\/[sq]\b/i,
    why: 'recursive directory delete (rd /s /q) is forbidden' },
  { re: /\bdel\s+\/[sq]\b/i,
    why: 'recursive file delete (del /s /q) is forbidden' },
  { re: /\breg\s+(delete|import)\b/i,
    why: 'editing the Windows registry is forbidden' },
  { re: /\bbcdedit\b/i,
    why: 'boot configuration edits are forbidden' },

  // --- Killing the machine / the host --------------------------------------
  { re: /\b(shutdown|restart-computer|Stop-Computer)\b/i,
    why: 'shutting down the host is forbidden' },
  { re: /\btaskkill\b.*\bexplorer(\.exe)?\b/i,
    why: 'killing the desktop shell is forbidden' },

  // --- Escaping into the host OS -------------------------------------------
  { re: /\bmount\b|\bumount\b/i,
    why: 'mounting filesystems is forbidden' },
  { re: /\bdocker\b|\bpodman\b|\bcontainerd\b/i,
    why: 'the agent must not manage containers (escape risk)' },
  { re: /curl[^|]*\|\s*(ba|z|k)?sh/i,
    why: 'piping a download straight into a shell is forbidden' },
  { re: /\bwget[^|]*\|\s*(ba|z|k)?sh/i,
    why: 'piping a download straight into a shell is forbidden' },
  { re: /\biex\b|Invoke-Expression/i,
    why: 'dynamic code evaluation is forbidden' },

  // --- Fork bomb (a classic: defines a function that calls itself) ---------
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    why: 'fork bomb is forbidden' },

  // --- Reading secrets that should never leave the host ---------------------
  { re: /\.ssh[\\/]/i,
    why: 'reading SSH keys is forbidden' },
  { re: /\.aws[\\/]/i,
    why: 'reading AWS credentials is forbidden' },
  { re: /\.gnupg[\\/]/i,
    why: 'reading GPG keys is forbidden' },
  { re: /\bid_rsa\b|\bid_ed25519\b/i,
    why: 'reading private keys is forbidden' },
];

/**
 * Validate a shell command. Throws SecurityError if it matches a block pattern.
 *
 * @param {string} command  the raw command string the model wants to run
 * @throws {SecurityError}
 */
export function checkCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new SecurityError('command must be a non-empty string');
  }

  for (const rule of BLOCKED_COMMANDS) {
    if (rule.re.test(command)) {
      throw new SecurityError(`blocked command: ${rule.why}`);
    }
  }

  // Anything that tries to reach outside the workspace via a hard absolute
  // path is suspicious. We allow relative paths and `cd` into subfolders.
  // (We deliberately do NOT block every absolute path — many legit tools print
  // or accept them. This is a soft heuristic, see the honesty note above.)
  if (/(\.\.[\\/]){3,}/.test(command)) {
    throw new SecurityError(
      'escaping far above the workspace with ../../ is forbidden',
    );
  }
}

// ===========================================================================
// PART 3 — OUTPUT HYGIENE
// ===========================================================================

/**
 * Truncate oversized command output.
 *
 * WHY: `grep -r "" C:\` or a runaway `print()` loop can produce gigabytes.
 * If we forward all of it to the LLM we blow the context window AND our RAM.
 *
 * We keep the head (usually the interesting part) and the tail (often the
 * error/stack trace) and note how much we dropped in the middle.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateOutput(text, maxBytes = config.maxOutputBytes) {
  if (typeof text !== 'string') text = String(text ?? '');

  // Buffer.byteLength counts actual bytes (multibyte characters count more
  // than 1) which is what we actually care about for memory.
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text;

  const headBytes = Math.floor(maxBytes * 0.6);
  const tailBytes = maxBytes - headBytes;

  const head = Buffer.from(text, 'utf8').subarray(0, headBytes).toString('utf8');
  const tail = Buffer.from(text, 'utf8')
    .subarray(Buffer.byteLength(text, 'utf8') - tailBytes)
    .toString('utf8');

  return (
    head +
    `\n\n... [OUTPUT TRUNCATED: showing first ${headBytes} and last ` +
    `${tailBytes} bytes of ${total} total bytes] ...\n\n` +
    tail
  );
}

/**
 * Strip secret-looking keys out of an environment object.
 *
 * WHY: we hand a (minimal) environment to every spawned command. If we passed
 * the full `process.env`, then a command like `set` or `env` — or worse, a
 * curl to a logging endpoint — could exfiltrate OPENAI_API_KEY.
 *
 * Strategy: copy the env, then DELETE any variable whose NAME looks sensitive.
 */
export function buildSandboxEnv() {
  const safe = { ...process.env };

  const suspiciousName = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

  for (const name of Object.keys(safe)) {
    if (suspiciousName.test(name)) {
      delete safe[name];
    }
  }

  // Belt and braces: explicitly remove ours even if the regex missed.
  delete safe.OPENAI_API_KEY;
  delete safe.TAVILY_API_KEY;

  return safe;
}
