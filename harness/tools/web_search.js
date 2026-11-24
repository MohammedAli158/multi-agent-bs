/**
 * ============================================================================
 * harness/tools/web_search.js  —  INTERNET LOOKUP (HOST-SIDE)
 * ============================================================================
 *
 * WHY IS THIS NOT IN THE SANDBOX?
 * -------------------------------
 * Two reasons:
 *   1. The sandbox has no network access in the hardened configuration, so it
 *      physically couldn't reach the internet.
 *   2. Search is a *read-only* API call with a key. There's no reason to give
 *      the agent a network-capable process just to look something up.
 * This is the clean separation: untrusted code runs in the sandbox, trusted
 * integrations (APIs) stay on the host.
 *
 * TWO PROVIDERS, ONE INTERFACE
 * ----------------------------
 * - If TAVILY_API_KEY is set -> use Tavily (a real search API built for LLMs).
 * - Otherwise               -> DuckDuckGo's free Instant Answer API.
 *   No key required, but it returns limited results (it's an "answer" API,
 *   not a full web index). Good enough to learn with; upgrade when you want
 *   production-quality results.
 */

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const DDG_ENDPOINT = 'https://api.duckduckgo.com/';

/**
 * @param {object} args  { query, max_results }
 * @returns {Promise<string>} formatted results, ready to feed the LLM
 */
export async function webSearch(args) {
  const query = args?.query;
  if (typeof query !== 'string' || !query.trim()) {
    return 'ERROR: query must be a non-empty string';
  }

  const maxResults = Math.min(Math.max(Number(args.max_results) || 10, 1), 20);

  try {
    if (process.env.TAVILY_API_KEY) {
      return await searchTavily(query, maxResults);
    }
    return await searchDuckDuckGo(query, maxResults);
  } catch (err) {
    // Never let a network hiccup crash the agent loop — report it as a tool
    // result so the model can rephrase or give up gracefully.
    return `ERROR: web search failed: ${err.message}`;
  }
}

/** Tavily — POST, returns rich results, requires a free API key. */
async function searchTavily(query, maxResults) {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // NOTE: the key goes in the BODY for Tavily, not a header. If you ever
    // see a 401 from them, this is the first thing to check.
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: maxResults,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily responded ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const results = (data.results || []).map((r, i) =>
    [
      `${i + 1}. ${r.title}`,
      `   URL: ${r.url}`,
      `   ${(r.content || '').slice(0, 400)}`,
    ].join('\n'),
  );

  if (results.length === 0) return `No results found for "${query}"`;
  return `Search results for "${query}":\n\n${results.join('\n\n')}`;
}

/** DuckDuckGo Instant Answer — GET, no key, limited but zero-setup. */
async function searchDuckDuckGo(query, maxResults) {
  // `no_html=1` strips markup so we get clean text, not HTML fragments.
  const url = new URL(DDG_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');

  const res = await fetch(url, { headers: { 'User-Agent': 'thinkcel-agent/1.0' } });
  if (!res.ok) throw new Error(`DuckDuckGo responded ${res.status}`);

  const data = await res.json();

  const results = [];

  // DDG's shape: AbstractText is a direct answer, RelatedTopics is a list.
  if (data.AbstractText) {
    results.push(`ANSWER: ${data.AbstractText}`);
    if (data.AbstractURL) results.push(`SOURCE: ${data.AbstractURL}`);
  }

  for (const topic of (data.RelatedTopics || []).slice(0, maxResults)) {
    if (topic.Text && topic.FirstURL) {
      results.push(`- ${topic.Text}\n  ${topic.FirstURL}`);
    } else if (topic.Topics) {
      // Nested one level deep — DDG does this for broad subjects.
      for (const sub of topic.Topics.slice(0, 3)) {
        if (sub.Text && sub.FirstURL) {
          results.push(`- ${sub.Text}\n  ${sub.FirstURL}`);
        }
      }
    }
  }

  if (results.length === 0) {
    return (
      `No instant answer for "${query}". ` +
      `Tip: set TAVILY_API_KEY in .env for full web search results.`
    );
  }

  return `Search results for "${query}":\n\n${results.join('\n\n')}`;
}
