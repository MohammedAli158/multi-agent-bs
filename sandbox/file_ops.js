/**
 * ============================================================================
 * sandbox/file_ops.js  —  THE FILE TOOLS (read / write / edit / find / grep)
 * ============================================================================
 *
 * WHY DO THESE LIVE IN THE SANDBOX FOLDER?
 * ----------------------------------------
 * Because they must only ever touch the session's private workspace. Every
 * function here goes through `resolveSafePath()` FIRST, which guarantees the
 * final path is inside the sandbox. That single choke point is what stops the
 * model from reading `C:\Users\you\.ssh\id_rsa`.
 *
 * WHY RUN THESE ON THE HOST RATHER THAN INSIDE A CONTAINER?
 * ----------------------------------------------------------
 * The workspace folder is (conceptually) *mounted* into the sandbox. So the
 * host and the sandbox see the SAME files. Doing file I/O locally is:
 *   - much faster than shelling out for every read
 *   - fully portable (works on Windows without a container)
 *   - easier to debug
 * Only `shell` needs to actually execute code, and that goes through
 * sandbox_execute.js.
 *
 * ALL OF THESE RETURN STRINGS, because that's what the `tool` message in the
 * chat-completions API requires (`content` must be text).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveSafePath,
  resolveSafePathForWrite,
  truncateOutput,
  SecurityError,
} from './security.js';
import { config } from '../config.js';

// Hard ceiling on how big a file we're willing to slurp into memory.
// A model doesn't need 500MB of logs, and neither do we.
const MAX_READ_BYTES = 200_000;

/** Wrap any thrown error into a string the LLM can read and react to. */
function fail(err) {
  if (err instanceof SecurityError) return `SECURITY ERROR: ${err.message}`;
  if (err.code === 'ENOENT') return `ERROR: file not found: ${err.path}`;
  if (err.code === 'EISDIR') return 'ERROR: that path is a directory, not a file';
  return `ERROR: ${err.message}`;
}

// ===========================================================================
// read_file
// ===========================================================================

/**
 * Read a text file, optionally only a slice of lines.
 *
 * WHY OFFSET/LIMIT? Context windows are finite and expensive. When an agent
 * wants to inspect a 10,000-line file it should read the interesting part,
 * not burn 200k tokens on the whole thing. This mirrors how real coding
 * agents (including me) work.
 *
 * @param {string} workspaceDir
 * @param {object} args  { path, offset?, limit? }
 * @returns {Promise<string>}
 */
export async function readFile(workspaceDir, args) {
  try {
    const safe = await resolveSafePath(workspaceDir, args.path);

    const stat = await fs.stat(safe);
    if (stat.isDirectory()) {
      return `ERROR: ${args.path} is a directory. Use list_dir instead.`;
    }
    if (stat.size > MAX_READ_BYTES) {
      return (
        `ERROR: file is ${stat.size} bytes, over the ${MAX_READ_BYTES} byte ` +
        `read limit. Read it in slices using offset/limit.`
      );
    }

    const raw = await fs.readFile(safe, 'utf8');
    const lines = raw.split(/\r?\n/);

    // Normalise offset to a sane 1-based start line.
    const start = Math.max(0, (Number(args.offset) || 1) - 1);
    const limit = Number(args.limit) || 2000;
    const slice = lines.slice(start, start + limit);

    if (slice.length === 0) {
      return `File ${args.path} has ${lines.length} line(s); offset ${start + 1} is past the end.`;
    }

    // Numbering the lines makes it MUCH easier for the model to reference a
    // location later ("line 42"), which is what edit_file needs.
    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(5)}| ${line}`)
      .join('\n');

    const header =
      `File: ${args.path}  (total ${lines.length} lines, showing ` +
      `${start + 1}-${start + slice.length})`;

    return truncateOutput(`${header}\n\n${numbered}`, MAX_READ_BYTES);
  } catch (err) {
    return fail(err);
  }
}

// ===========================================================================
// write_file
// ===========================================================================

/**
 * Create or overwrite a file. Creates missing parent directories.
 *
 * @param {string} workspaceDir
 * @param {object} args  { path, content }
 * @returns {Promise<string>}
 */
export async function writeFile(workspaceDir, args) {
  try {
    if (typeof args.content !== 'string') {
      return 'ERROR: content must be a string';
    }

    // resolveSafePathForWrite = resolve + mkdir -p the parent folder.
    const safe = await resolveSafePathForWrite(workspaceDir, args.path);

    // Detect overwrite vs create — the model likes knowing which happened.
    const existed = await fs.access(safe).then(() => true).catch(() => false);

    await fs.writeFile(safe, args.content, 'utf8');

    const bytes = Buffer.byteLength(args.content, 'utf8');
    const lines = args.content.split('\n').length;
    return `OK: ${existed ? 'overwrote' : 'created'} ${args.path} (${lines} lines, ${bytes} bytes)`;
  } catch (err) {
    return fail(err);
  }
}

// ===========================================================================
// edit_file
// ===========================================================================

/**
 * Surgical string replacement — the single most important file tool.
 *
 * WHY NOT JUST `sed` VIA THE SHELL?
 *   Because shell escaping on Windows vs Linux is a nightmare and one bad
 *   quote destroys a file. Doing it in JS is deterministic and testable.
 *
 * THE CONTRACT (same as the real coding-agent edit tool):
 *   - old_string must match EXACTLY, whitespace included
 *   - old_string must be UNIQUE in the file unless replace_all is true
 *   - both rules are enforced, because silently replacing the wrong
 *     occurrence is how agents corrupt code
 *
 * @param {string} workspaceDir
 * @param {object} args  { path, old_string, new_string, replace_all? }
 * @returns {Promise<string>}
 */
export async function editFile(workspaceDir, args) {
  try {
    const { old_string, new_string } = args;

    if (typeof old_string !== 'string' || old_string === '') {
      return 'ERROR: old_string is required and must be a non-empty string';
    }
    if (typeof new_string !== 'string') {
      return 'ERROR: new_string must be a string (use "" to delete)';
    }
    if (old_string === new_string) {
      return 'ERROR: old_string and new_string are identical';
    }

    const safe = await resolveSafePath(workspaceDir, args.path);
    const original = await fs.readFile(safe, 'utf8');

    // Count occurrences BEFORE touching anything.
    const occurrences = original.split(old_string).length - 1;

    if (occurrences === 0) {
      // Give the model something actionable: tell it where the nearest
      // similar text is, so its next attempt has a chance of succeeding.
      return (
        `ERROR: old_string not found in ${args.path}.\n` +
        `The file is ${original.split('\n').length} lines long. ` +
        `Re-read it and copy the target text EXACTLY, including indentation.`
      );
    }

    if (occurrences > 1 && !args.replace_all) {
      return (
        `ERROR: old_string matches ${occurrences} times in ${args.path}. ` +
        `Make it unique (include more surrounding context) or set ` +
        `replace_all to true.`
      );
    }

    let updated;
    if (args.replace_all) {
      updated = original.split(old_string).join(new_string);
    } else {
      // Only the first occurrence — already verified it's exactly one.
      const idx = original.indexOf(old_string);
      updated =
        original.slice(0, idx) + new_string + original.slice(idx + old_string.length);
    }

    await fs.writeFile(safe, updated, 'utf8');

    return (
      `OK: edited ${args.path} ` +
      `(replaced ${args.replace_all ? occurrences : 1} occurrence(s))`
    );
  } catch (err) {
    return fail(err);
  }
}

// ===========================================================================
// glob  (find files by pattern)
// ===========================================================================

/**
 * Find files whose path matches a glob pattern like `**\/*.js`.
 *
 * WHY A HAND-WRITTEN GLOB?
 *   Zero dependencies, and it makes the mechanics visible — which is the
 *   point of this project. We walk the tree once, collect relative paths,
 *   then test each against a regex built from your pattern.
 *
 * @param {string} workspaceDir
 * @param {object} args  { pattern, path? }
 * @returns {Promise<string>}
 */
export async function globFiles(workspaceDir, args) {
  try {
    const base = args.path
      ? await resolveSafePath(workspaceDir, args.path)
      : workspaceDir;

    const pattern = args.pattern;
    if (typeof pattern !== 'string' || !pattern) {
      return 'ERROR: pattern is required, e.g. "**/*.js"';
    }

    const matcher = globToRegExp(pattern);
    const matches = [];

    // Iterative walk (explicit stack instead of recursion) so a pathological
    // deep tree can't blow the JS call stack.
    const stack = [''];
    while (stack.length > 0) {
      const rel = stack.pop();
      const abs = rel ? path.join(base, rel) : base;

      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        continue; // unreadable folder: skip rather than abort the whole search
      }

      for (const entry of entries) {
        // Never descend into junk that would only slow us down or leak
        // information about the host.
        if (entry.name === 'node_modules' || entry.name === '.git') continue;

        const childRel = rel ? `${rel}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          stack.push(childRel);
        } else if (entry.isFile()) {
          // We match against POSIX-style separators regardless of OS so that
          // `**/*.js` behaves identically on Windows and Linux.
          if (matcher.test(childRel)) matches.push(childRel);
        }
      }
    }

    matches.sort();

    if (matches.length === 0) return `No files matched pattern "${pattern}"`;
    return truncateOutput(matches.join('\n'), 10_000);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Convert a glob pattern into an anchored regular expression.
 *
 * SUPPORTED:
 *   *      -> any characters except a path separator
 *   **     -> any number of path segments (including none)
 *   ?      -> exactly one character except a separator
 *   [abc]  -> character class (passed through)
 *
 * Example: "**" + "/" + "*.js"  ->  /^(?:[^/]+\/)*[^/]*\.js$/
 *
 * (The pattern above is written in pieces because a literal star-slash would
 *  terminate this comment block early — a classic JS gotcha.)
 */
function globToRegExp(pattern) {
  let re = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — swallow an optional following separator so `**/*.js`
        // matches "file.js" at the root as well as "a/b/file.js".
        i += 2;
        if (pattern[i] === '/') i++;
        re += '(?:[^/]+\\/)*';
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      // Copy a character class through verbatim until the closing bracket.
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
        i++;
      } else {
        re += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      // Escape regex metacharacters so a literal `.` isn't a wildcard.
      re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
      i++;
    }
  }

  return new RegExp(`^${re}$`);
}

// ===========================================================================
// grep  (search file contents)
// ===========================================================================

/**
 * Search every text file under `path` for a regular expression, returning
 * `file:line: text` for each hit — exactly the format `read_file` line
 * numbers and `edit_file` need to line up with.
 *
 * @param {string} workspaceDir
 * @param {object} args  { pattern, path?, case_insensitive? }
 * @returns {Promise<string>}
 */
export async function grepFiles(workspaceDir, args) {
  try {
    const pattern = args.pattern;
    if (typeof pattern !== 'string' || !pattern) {
      return 'ERROR: pattern is required';
    }

    // Build the regex. `u` = unicode-aware, `i` = case-insensitive if asked.
    let regex;
    try {
      regex = new RegExp(pattern, args.case_insensitive ? 'iu' : 'u');
    } catch (err) {
      // An invalid regex from the model is common — report it, don't crash.
      return `ERROR: invalid regular expression: ${err.message}`;
    }

    const base = args.path
      ? await resolveSafePath(workspaceDir, args.path)
      : workspaceDir;

    const files = await listFilesRecursive(base);
    const hits = [];
    let truncated = false;

    for (const abs of files) {
      if (hits.length >= 200) { truncated = true; break; }

      let stat;
      try {
        stat = await fs.stat(abs);
      } catch { continue; }

      // Skip binaries and oversized files: reading a 500MB .mp4 as UTF-8 is
      // pointless and slow.
      if (stat.size > 1_000_000) continue;

      let text;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch { continue; }

      // Cheap binary sniff: NUL bytes mean it's not text.
      if (text.includes('\u0000')) continue;

      const rel = path.relative(base, abs).split(path.sep).join('/');
      const lines = text.split(/\r?\n/);

      for (let n = 0; n < lines.length; n++) {
        if (hits.length >= 200) { truncated = true; break; }
        if (regex.test(lines[n])) {
          hits.push(`${rel}:${n + 1}: ${lines[n].trim().slice(0, 300)}`);
        }
      }
    }

    if (hits.length === 0) return `No matches for pattern "${pattern}"`;

    let out = hits.join('\n');
    if (truncated) out += '\n\n[results truncated at 200 matches]';
    return truncateOutput(out, 50_000);
  } catch (err) {
    return fail(err);
  }
}

/** Recursive file listing helper (skips node_modules/.git, yields abs paths). */
async function listFilesRecursive(dir, acc = [], depth = 0) {
  if (depth > 12) return acc; // guard against symlink-style infinite loops
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await listFilesRecursive(abs, acc, depth + 1);
    else if (e.isFile()) acc.push(abs);
  }
  return acc;
}

// ===========================================================================
// list_dir
// ===========================================================================

/**
 * List one directory level. Annotated with `/` for folders and file sizes so
 * the model can decide where to look next without extra round-trips.
 *
 * @param {string} workspaceDir
 * @param {object} args  { path?, include_hidden? }
 * @returns {Promise<string>}
 */
export async function listDir(workspaceDir, args = {}) {
  try {
    const target = args.path
      ? await resolveSafePath(workspaceDir, args.path)
      : workspaceDir;

    const entries = await fs.readdir(target, { withFileTypes: true });

    const rows = [];
    for (const e of entries) {
      // Hidden files (dotfiles) are skipped unless explicitly requested —
      // they're usually noise for an agent.
      if (!args.include_hidden && e.name.startsWith('.')) continue;

      if (e.isDirectory()) {
        rows.push(`  ${e.name}/`);
      } else {
        let size = '';
        try {
          const st = await fs.stat(path.join(target, e.name));
          size = `${st.size} B`;
        } catch { /* raced with a delete; leave blank */ }
        rows.push(`  ${e.name}  (${size})`);
      }
    }

    rows.sort();

    const rel = path.relative(workspaceDir, target).split(path.sep).join('/') || '.';
    if (rows.length === 0) return `${rel}/ is empty`;
    return `${rel}/\n${rows.join('\n')}`;
  } catch (err) {
    return fail(err);
  }
}
