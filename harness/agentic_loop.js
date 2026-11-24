/**
 * ============================================================================
 * harness/agentic_loop.js  —  THE HEART OF THE SYSTEM
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Repeats one cycle until the model stops asking for tools:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  1. send conversation to the LLM                            │
 *   │  2. LLM replies                                             │
 *   │     ├─ has tool_calls? ──> run them ──> append results ──┐   │
 *   │     │                                                   │   │
 *   │     │              ◄────────────────────────────────────┘   │
 *   │     └─ plain text? ──> that's the final answer, RETURN      │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * This "LLM -> tool -> LLM -> tool" cycle IS what people mean by an agent.
 * A chatbot answers once. An agent acts until the job is done.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THAT MAKE A LOOP SAFE
 * ---------------------------------------------------------------------------
 * 1. MAX ITERATIONS   — guarantees termination even if the model loops.
 * 2. HISTORY MUTATION — every turn is appended to `session.messages`, so the
 *                       model can see everything it already tried. Without
 *                       this it would repeat itself forever.
 * 3. ERROR-AS-DATA    — tool failures come back as strings, never exceptions.
 *
 * ---------------------------------------------------------------------------
 * HOW STREAMING WORKS HERE
 * ---------------------------------------------------------------------------
 * We don't stream tokens (chat.completions non-streaming). Instead we emit
 * *milestone events* over Socket.IO: tool_start, tool_result, assistant,
 * done, error. That's plenty for a UI that shows "running shell: npm test…"
 * — and it's far simpler to reason about than raw token streams.
 * ===========================================================================
 */

import { callLLM } from './llm_client.js';
import { tools } from './tools/tool_calls.js';
import { executeTool } from './tools/toolExecute.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { config } from '../config.js';

/**
 * Run one user request to completion.
 *
 * @param {object} session   from sessionStore — MUST have `.messages`, `.id`,
 *                           `.sandbox` (with `.cwd`)
 * @param {string} userText  what the human asked for
 * @param {function} [emit]  (event, payload) => void  — progress reporting.
 *                           Defaults to a no-op so this function can be used
 *                           in tests or scripts with no socket attached.
 * @returns {Promise<string>} the model's final text answer
 */
export async function run(session, userText, emit = () => {}) {
  // ---- STEP 0: record the human's message --------------------------------
  // We push onto session.messages (not a local array) so the history
  // persists across requests in the same session — the agent remembers.
  session.messages.push({ role: 'user', content: userText });

  // The system prompt is rebuilt each turn on purpose: it embeds the session
  // id and workspace path, which can change if the sandbox is recreated.
  const systemMessage = {
    role: 'system',
    content: buildSystemPrompt(session),
  };

  // ---- THE LOOP -----------------------------------------------------------
  for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
    emit('iteration', { iteration, max: config.maxIterations });

    // Assemble what we send: system first, then the running history.
    const requestMessages = [systemMessage, ...session.messages];

    let assistantMessage;
    try {
      assistantMessage = await callLLM(requestMessages, tools);
    } catch (err) {
      // A provider failure (bad key, network, invalid model) aborts the run.
      emit('error', { message: err.message });
      throw err;
    }

    // IMPORTANT: persist the assistant's turn BEFORE running tools. If we
    // crashed halfway through, the history would at least be consistent —
    // and the API requires the tool result to directly follow the message
    // that requested it.
    session.messages.push(assistantMessage);

    // ---- CASE A: the model answered in plain text -> WE'RE DONE -----------
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const finalText = assistantMessage.content ?? '';
      emit('assistant', { text: finalText });
      return finalText;
    }

    // ---- CASE B: the model wants tools -> run every one of them -----------
    for (const toolCall of assistantMessage.tool_calls) {
      const name = toolCall.function?.name;
      const argsPreview = safePreview(toolCall.function?.arguments);

      emit('tool_start', { id: toolCall.id, name, args: argsPreview });
      console.log(`[agent] iter ${iteration} -> ${name}(${argsPreview})`);

      // executeTool never throws (see toolExecute.js) — it returns an error
      // STRING, which is exactly what we want to hand back to the model.
      const result = await executeTool(toolCall, session);

      emit('tool_result', {
        id: result.toolCallId,
        name: result.name,
        content: truncateForLog(result.content),
      });
      console.log(`[agent] ${name} ->`, truncateForLog(result.content));

      // This is the message shape the API requires for a tool response:
      // `role`, the matching `tool_call_id`, and a STRING `content`.
      session.messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }

    // Loop continues -> we go back to STEP 1 with the updated history.
  }

  // ---- GUARD RAIL: we ran out of iterations -------------------------------
  // Without this the function would fall off the end and return `undefined`,
  // which then crashes whoever expected a string.
  const giveUp =
    `Stopped after ${config.maxIterations} tool iterations without a final ` +
    `answer. Increase config.maxIterations, or ask the agent to finish ` +
    `the current task first.`;

  emit('error', { message: giveUp });

  session.messages.push({ role: 'assistant', content: giveUp });
  return giveUp;
}

/**
 * Shorten arbitrary text for logging/events.
 * Tool output can be 100KB; streaming all of that into a browser console or
 * a socket room is a great way to freeze the UI. The FULL text still goes to
 * the model — this only affects what we emit for humans.
 */
function truncateForLog(text, max = 2000) {
  if (typeof text !== 'string') return String(text ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [${text.length - max} more chars]`;
}

/** Same idea, for the raw arguments blob a model emits. */
function safePreview(raw, max = 500) {
  if (typeof raw !== 'string') return String(raw ?? '');
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`;
}
