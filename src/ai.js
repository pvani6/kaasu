// Google Gemini client (free tier from Google AI Studio).
// Plain REST calls, no SDK, so it is easy to read and has zero extra dependencies.

const KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MODE = KEY ? 'gemini' : 'fallback';

class AIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// contents: Gemini "contents" array. tools: array of function declarations.
async function generate({ system, contents, tools, temperature = 0.4 }) {
  if (!KEY) throw new AIError('No GEMINI_API_KEY set', 0);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
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
    if (res.status === 404) hint = ` (model "${MODEL}" not found, set GEMINI_MODEL in .env to a model listed in Google AI Studio)`;
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
