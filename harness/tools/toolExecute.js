/**
 * ============================================================================
 * harness/tools/toolExecute.js  —  THE DISPATCH TABLE
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * The model says:  { name: "edit_file", arguments: '{"path":"a.js",...}' }
 * This file turns that into:  a running function, and a string back.
 *
 * IT IS THE BOUNDARY BETWEEN "THE MODEL ASKED" AND "WE ACTUALLY DID IT".
 *
 * ---------------------------------------------------------------------------
 * THE SINGLE MOST IMPORTANT RULE IN THIS FILE
 * ---------------------------------------------------------------------------
 * A tool must NEVER throw out of this function.
 *
 * Why: if a tool throws, the exception bubbles up through the agent loop, up
 * through Express, and kills the whole Node process (you saw exactly that
 * with the 400 error earlier — one bad call took down the server).
 *
 * Instead, every failure is caught and RETURNED AS A STRING. The model reads
 * "ERROR: file not found", understands it, and tries a different path. This
 * is what makes agents resilient: errors are *information*, not crashes.
 * ===========================================================================
 */

import * as fileOps from '../../sandbox/file_ops.js';
import { webSearch } from './web_search.js';
import { toolNames } from './tool_calls.js';

/**
 * The registry. Key = tool name as declared in tool_calls.js.
 * Value = async (args, session) => string
 *
 * ADDING A NEW TOOL IS A 3-STEP PROCESS:
 *   1. Add its schema to tool_calls.js   (so the model knows it exists)
 *   2. Add the implementation here       (so we can actually run it)
 *   3. Nothing else — the loop picks it up automatically.
 */
const registry = {
  // ---- Runs code. This is the one that touches the OS. --------------------
  shell: async (args, session) => {
    if (typeof args.command !== 'string' || !args.command.trim()) {
      return 'ERROR: command is required and must be a non-empty string';
    }

    const timeoutMs = args.timeout
      ? Math.min(Math.max(Number(args.timeout), 1), 600) * 1000
      : undefined;

    // session.sandbox is the swappable handle from sandbox_setup.js.
    // Right now .exec() calls child_process; with Docker it would call
    // `docker exec`. THIS LINE IS THE ONLY THING THAT WOULD CHANGE.
    return session.sandbox.run(args.command, timeoutMs ? { timeoutMs } : {});
  },

  // ---- Pure file operations: always scoped to session.sandbox.cwd ---------
  read_file: (args, session) => fileOps.readFile(session.sandbox.cwd, args),
  write_file: (args, session) => fileOps.writeFile(session.sandbox.cwd, args),
  edit_file: (args, session) => fileOps.editFile(session.sandbox.cwd, args),
  glob: (args, session) => fileOps.globFiles(session.sandbox.cwd, args),
  grep: (args, session) => fileOps.grepFiles(session.sandbox.cwd, args),
  list_dir: (args, session) => fileOps.listDir(session.sandbox.cwd, args),

  // ---- Host-side integration. Note: no `session` needed at all. -----------
  web_search: (args) => webSearch(args),
};

/**
 * Execute one tool call.
 *
 * @param {object} toolCall      an entry from response.choices[0].message.tool_calls
 *                               e.g. { id, type:'function', function:{ name, arguments } }
 * @param {object} session       { id, sandbox, messages, ... } from sessionStore
 * @returns {Promise<{toolCallId:string, name:string, content:string}>}
 *
 * NOTE the return shape: `toolCallId` is REQUIRED by the API. The model
 * matches our reply back to its request using that id. Forget it and you get
 * "tool_call_id is required" (or worse, silent confusion).
 */
export async function executeTool(toolCall, session) {
  const toolCallId = toolCall.id ?? 'unknown';
  const name = toolCall.function?.name;

  // 1. Is it even a tool we know about? A hallucinated tool name is a normal
  //    model mistake — tell it, don't crash.
  if (!name || !toolNames.has(name)) {
    return {
      toolCallId,
      name: name ?? 'unknown',
      content: `ERROR: unknown tool "${name}". Available tools: ${[...toolNames].join(', ')}`,
    };
  }

  // 2. Parse the JSON arguments. The model writes these as a STRING, so we
  //    must JSON.parse them. Models occasionally emit invalid JSON (trailing
  //    commas, single quotes), so parse errors are expected, not exceptional.
  let args = {};
  const rawArgs = toolCall.function.arguments;
  if (rawArgs && typeof rawArgs === 'string' && rawArgs.trim() !== '') {
    try {
      args = JSON.parse(rawArgs);
    } catch (err) {
      return {
        toolCallId,
        name,
        content:
          `ERROR: arguments were not valid JSON (${err.message}). ` +
          `Received: ${rawArgs.slice(0, 500)}. ` +
          `Send arguments as a single well-formed JSON object.`,
      };
    }
  }

  // 3. Run it, catching EVERYTHING. See the rule at the top of this file.
  try {
    const content = await registry[name](args, session);

    // Belt & braces: the API requires `content` to be a string. If an
    // implementation accidentally returns an object, stringify it rather
    // than sending something the API will reject.
    return {
      toolCallId,
      name,
      content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    };
  } catch (err) {
    // SecurityError, ENOENT, EACCES, a bad regex in the model's grep pattern…
    // all of them come back here as data the model can learn from.
    console.error(`[tool:${name}]`, err);
    return {
      toolCallId,
      name,
      content: `ERROR from tool "${name}": ${err.message}`,
    };
  }
}
