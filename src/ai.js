// Google Gemini client (free tier from Google AI Studio).
// Plain REST calls, no SDK, so it is easy to read and has zero extra dependencies.

const KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite';
const MODE = KEY ? 'gemini' : 'fallback';
let primaryBlockedUntil = 0; // after a rate-limit, skip the main model for a minute

class AIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// contents: Gemini "contents" array. tools: array of function declarations.
async function generate(opts) {
  if (!KEY) throw new AIError('No GEMINI_API_KEY set', 0);
  const models = Date.now() < primaryBlockedUntil ? [FALLBACK_MODEL] : [MODEL, FALLBACK_MODEL];
  let lastErr;
  for (const m of [...new Set(models)]) {
    try {
      return await generateWith(m, opts);
    } catch (err) {
      lastErr = err;
      // 429 = free-tier limit, 503 = model overloaded: try the lighter model instead.
      if (!(err instanceof AIError) || ![429, 500, 503].includes(err.status)) throw err;
      if (m === MODEL) primaryBlockedUntil = Date.now() + 60_000;
    }
  }
  throw lastErr;
}

async function generateWith(model, { system, contents, tools, temperature = 0.4 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      tools: tools && tools.length ? [{ functionDeclarations: tools }] : undefined,
      generationConfig: { temperature },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json.error && json.error.message) || 'HTTP ' + res.status;
    let hint = '';
    if (res.status === 429) hint = ' (free-tier rate limit reached, wait a minute)';
    if (res.status === 404) hint = ` (model "${model}" not found, set GEMINI_MODEL in .env to a model listed in Google AI Studio)`;
    throw new AIError('Gemini error: ' + msg + hint, res.status);
  }
  const cand = json.candidates && json.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) {
    throw new AIError('Gemini returned no answer' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : ''), 200);
  }
  return cand.content; // { role: 'model', parts: [...] }
}

function textOf(content) {
  return (content.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
}

async function generateText(prompt, system, temperature = 0.6) {
  const content = await generate({ system, contents: [{ role: 'user', parts: [{ text: prompt }] }], temperature });
  return textOf(content);
}

module.exports = { MODE, MODEL, AIError, generate, generateText, textOf };
