// src/prompt.js
//
// THE SWAP SEAM. This file is intentionally dead simple and fully isolated so the
// finance-niche version of TLDW can be created by editing ONLY this file: rewrite
// SYSTEM_PROMPT (and tweak buildUserMessage) to extract finance-specific signal
// (tickers, thesis, price targets, risks) while keeping the SAME JSON contract.
//
// JSON contract (must NOT change — worker.js, app.js, and the D1 cache all depend on it):
//   { tldr: string, keyPoints: string[], cheatSheet: string[] }

// System prompt: a sharp, concise summarizer that emits ONLY raw JSON.
export const SYSTEM_PROMPT = `You are a sharp, concise video summarizer. You read a full video transcript and extract only what genuinely matters — no filler, no padding, no restating the obvious.

Output ONLY valid JSON. No markdown code fences, no preamble, no trailing commentary — just the raw JSON object.

The JSON object must have EXACTLY these three keys:
- "tldr": a string. One tight paragraph (2-4 sentences) capturing the single most important takeaway.
- "keyPoints": an array of short strings. The main points, each one self-contained and concrete.
- "cheatSheet": an array of short, scannable strings. Quick-reference takeaways — facts, steps, terms, or numbers worth remembering at a glance.

Keep every string crisp. Prefer specifics over generalities. Never invent details that are not supported by the transcript.`;

/**
 * Build the user message string sent to the LLM.
 * Adaptive length: output is scaled to the video's length so short videos stay
 * tight and long videos stay high-signal (never padded).
 *
 * @param {string} transcript - the full transcript text (appended at the END).
 * @param {number} durationSeconds - approximate video length in seconds.
 * @returns {string} the user message.
 */
export function buildUserMessage(transcript, durationSeconds) {
  // Duration is surfaced to the model in MINUTES so it can size the output.
  const minutes = Math.max(1, Math.round((durationSeconds || 0) / 60));

  // Length guidance buckets: short / medium / long.
  let guidance;
  if (minutes < 15) {
    guidance =
      "This is a short video. Aim for about 4-6 key points and a brief cheat sheet.";
  } else if (minutes <= 45) {
    guidance =
      "This is a medium-length video. Aim for about 6-9 key points and a focused cheat sheet.";
  } else {
    guidance =
      "This is a long video. Be selective: capture only the highest-signal points (a tighter set than a medium video) — never pad to fill space.";
  }

  return `Summarize the following video transcript.

Video length: about ${minutes} minute${minutes === 1 ? "" : "s"}.
${guidance}

Remember: respond with ONLY the raw JSON object (keys: tldr, keyPoints, cheatSheet). No code fences, no extra text.

Transcript:
${transcript}`;
}
