/**
 * ============================================================================
 * harness/llm_client.js  —  THE ONLY FILE THAT TALKS TO THE LLM PROVIDER
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Wraps the OpenAI SDK in ONE function, `callLLM`, so the rest of the
 * codebase never has to know which provider is in use.
 *
 * WHY ISOLATE IT?
 * ---------------
 * Swapping OpenRouter -> OpenAI -> Anthropic (via a proxy) becomes a change
 * in THIS file only. Everything else keeps receiving plain `{ message }`.
 *
 * ---------------------------------------------------------------------------
 * WHY `chat.completions` AND NOT `responses`
 * ---------------------------------------------------------------------------
 * - chat.completions is the battle-tested endpoint. Every provider that
 *   claims OpenAI compatibility implements it fully, tool calling included.
 * - The newer /responses endpoint has uneven support across providers, and
 *   its tool format differs from chat completions. You hit this already:
 *   "Invalid Responses API request".
 * - The trade-off: chat completions is one-shot (no server-sent streaming of
 *   partial tokens unless you opt in with `stream:true`).
 * ---------------------------------------------------------------------------
 *
 * THE MESSAGE ARRAY (the shape the API expects)
 * ---------------------------------------------
 *   { role: "system",    content: "..." }                     <- our instructions
 *   { role: "user",      content: "..." }                     <- what the human said
 *   { role: "assistant", content: null, tool_calls: [...] }   <- model wants a tool
 *   { role: "tool",      tool_call_id, content: "..." }       <- our tool result
 *   { role: "assistant", content: "..." }                     <- final text answer
 *
 * Order matters. Every tool result MUST come immediately after the assistant
 * message that requested it, and MUST carry the matching `tool_call_id`.
 */

import OpenAI from 'openai';
import { config } from '../config.js';

/**
 * Lazily create the client on first use.
 *
 * WHY LAZY? Import order. If this module is imported before `--env-file`
 * has populated process.env, a top-level `new OpenAI(...)` would capture a
 * missing key and fail in a confusing way. Deferring until first call means
 * config.js has definitely been populated by then.
 */
let client = null;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      // Don't retry forever: a transient error should surface to the caller
      // after a couple of attempts rather than hanging the request.
      maxRetries: 2,
    });
  }
  return client;
}

/**
 * Send the conversation so far and get the model's next move back.
 *
 * @param {object[]} messages   full conversation history (see shape above)
 * @param {object[]} tools      schemas from tool_calls.js
 * @returns {Promise<object>}   the assistant message:
 *                              { role, content, tool_calls? }
 */
export async function callLLM(messages, tools) {
  const response = await getClient().chat.completions.create({
    model: config.model,
    messages,
    // Tool definitions. Sending them every turn costs tokens but is how the
    // model remembers what it can do.
    tools,
    // "auto" = the model MAY call tools, or MAY just answer in text.
    // Other options: "none" (force a plain answer), or forcing a specific
    // function (rarely what you want for a general agent).
    tool_choice: 'auto',
    max_tokens: config.maxOutputTokens,
    temperature: 0.2,
    // ^ Low-ish temperature: for a coding agent we want predictable, faithful
    //   tool calls, not creative inventions. Raise it if you want more
    //   exploratory behaviour.
  });

  // The SDK nests the reply under choices[0]. There is always exactly one
  // choice because we didn't ask for n > 1.
  const message = response.choices?.[0]?.message;

  if (!message) {
    // A missing message means the provider did something unexpected (or
    // returned a "content filter" refusal with no content). Surface it as a
    // real error so the agent loop can abort cleanly instead of looping on
    // an empty reply forever.
    const reason = response.choices?.[0]?.finish_reason ?? 'unknown';
    throw new Error(`LLM returned no message (finish_reason=${reason})`);
  }

  return message;
}

/**
 * Diagnostic helper used by the health endpoint / curl tests.
 * Lets you verify the key and base URL without running the whole agent.
 */
export async function pingLLM() {
  const message = await callLLM(
    [{ role: 'user', content: 'Reply with the single word: pong' }],
    [],
  );
  return message.content;
}
