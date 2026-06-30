// src/worker.js — TLDW Cloudflare Worker
// ----------------------------------------------------------------------------
// Why Supadata instead of fetching transcripts ourselves:
// YouTube actively blocks requests coming from datacenter / cloud IP ranges
// (which is exactly what a Cloudflare Worker is). A direct transcript scrape
// from here would get rate-limited or outright refused. Supadata runs the
// fetch from residential-grade infrastructure and hands us back clean
// transcript text, so we proxy through their API rather than hitting YouTube.
//
// Design note: the three "swappable seams" — getTranscript(), summarize(),
// and the per-provider summarizeWithOpenAI()/summarizeWithClaude() — are kept
// small and self-contained on purpose. The planned finance-niche version only
// needs to touch these (plus src/prompt.js), not the routing/cache/rate-limit
// plumbing.
// ----------------------------------------------------------------------------

import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

// Shared CORS headers — attached to EVERY response (success, error, preflight).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Single JSON-response helper. ALWAYS use this so CORS + content-type are never
// forgotten on any code path.
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Canonical video-id shape (must match the frontend + the shared contract).
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export default {
  async fetch(request, env, ctx) {
    // Outer try/catch — any unexpected throw becomes a clean 500 with CORS.
    try {
      const url = new URL(request.url);

      // --- OPTIONS preflight ------------------------------------------------
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // --- Main API route ---------------------------------------------------
      if (url.pathname === "/api/summarize" && request.method === "POST") {
        return await handleSummarize(request, env);
      }

      // --- Any other /api/* path -------------------------------------------
      // Static assets are served by the [assets] binding (run_worker_first
      // only routes /api/* here), so anything else under /api/* is a 404.
      if (url.pathname.startsWith("/api/")) {
        return json({ error: "not_found" }, 404);
      }

      // Non-/api/* should never reach the Worker (assets handle it), but be safe.
      return json({ error: "not_found" }, 404);
    } catch (err) {
      // Generic catch-all for unexpected throws.
      console.error("server_error:", err && err.stack ? err.stack : err);
      return json({ error: "server_error" }, 500);
    }
  },
};

// ============================================================================
// MAIN HANDLER  — POST /api/summarize
// ============================================================================
async function handleSummarize(request, env) {
  // 1. Parse + validate the video id ----------------------------------------
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_id" }, 400);
  }
  const videoId = body && body.videoId;
  if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) {
    return json({ error: "invalid_id" }, 400);
  }

  // 2. Rate limit per client IP via the native binding ----------------------
  // Guard: in local dev (`wrangler dev`) the unsafe ratelimit binding may not
  // be present, so we skip limiting when env.RATE_LIMITER is undefined.
  if (env.RATE_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return json({ error: "rate_limited" }, 429);
    }
  }

  // 3. Cache check (D1) — the main cost saver -------------------------------
  // If we've summarized this video before, return it immediately with no
  // Supadata or LLM call.
  const cached = await env.DB.prepare(
    "SELECT summary_json FROM summaries WHERE video_id = ?"
  )
    .bind(videoId)
    .first();
  if (cached && cached.summary_json) {
    const summary = JSON.parse(cached.summary_json);
    return json({ ...summary, cached: true }, 200);
  }

  // 4. Fetch transcript (swappable seam) ------------------------------------
  const transcriptResult = await getTranscript(videoId, env);
  if (
    !transcriptResult ||
    !transcriptResult.content ||
    !transcriptResult.content.trim()
  ) {
    return json({ error: "no_transcript" }, 422);
  }
  const { content, durationSeconds } = transcriptResult;

  // 5. Summarize (swappable seam) -------------------------------------------
  const summary = await summarize(content, durationSeconds, env);
  if (!summary) {
    return json({ error: "summary_failed" }, 502);
  }

  // 6. Write to cache (D1). INSERT OR IGNORE so two concurrent requests for
  // the same fresh video don't error on the PRIMARY KEY.
  const summaryJson = JSON.stringify(summary);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO summaries (video_id, summary_json, created_at) VALUES (?, ?, ?)"
  )
    .bind(videoId, summaryJson, Date.now())
    .run();

  // 7. Return the fresh summary.
  return json({ ...summary, cached: false }, 200);
}

// ============================================================================
// SWAPPABLE SEAM #1 — getTranscript(videoId, env)
// Proxies the transcript fetch through Supadata. Returns
//   { content: string, durationSeconds: number }
// or null / empty content to signal "no transcript".
// ============================================================================
async function getTranscript(videoId, env) {
  // text=true asks Supadata for the full transcript as one plain string in
  // `data.content` (vs. timestamped segments). Simpler for summarizing.
  const params = new URLSearchParams({
    url: `https://www.youtube.com/watch?v=${videoId}`,
    text: "true",
  });
  // Tradeoff note: appending `&mode=native` would restrict Supadata to a
  // video's EXISTING captions and skip its paid AI-generation fallback. We
  // leave the default ON so videos without captions still get a transcript
  // (at the cost of a Supadata credit). Flip to native if cost matters more.
  const endpoint = `https://api.supadata.ai/v1/transcript?${params.toString()}`;

  const res = await fetch(endpoint, {
    method: "GET",
    headers: { "x-api-key": env.SUPADATA_API_KEY },
  });

  if (!res.ok) {
    // Non-2xx (e.g. no captions available / bad video) -> treat as no transcript.
    return null;
  }

  const data = await res.json();
  const content = data && data.content;
  if (!content || !content.trim()) {
    return null;
  }

  // Duration: Supadata's text=true response doesn't include a duration, so we
  // ESTIMATE it from word count at ~150 words/minute (typical speech rate).
  // This is a rough number used only to scale the summary length in the prompt.
  let durationSeconds;
  if (typeof data.durationSeconds === "number") {
    durationSeconds = data.durationSeconds;
  } else if (typeof data.duration === "number") {
    durationSeconds = data.duration;
  } else {
    const wordCount = content.trim().split(/\s+/).length;
    durationSeconds = Math.round((wordCount / 150) * 60); // estimate
  }

  return { content, durationSeconds };
}

// ============================================================================
// SWAPPABLE SEAM #2 — summarize(transcript, durationSeconds, env)
// Picks the LLM provider and returns a validated
//   { tldr: string, keyPoints: string[], cheatSheet: string[] }
// or null to signal "summary_failed".
// ============================================================================
async function summarize(transcript, durationSeconds, env) {
  // Truncate very long transcripts to the first ~50k chars to keep token usage
  // (and cost) bounded. Long videos still summarize fine from the front half;
  // the prompt is told to produce a tighter high-signal set for long videos.
  const MAX_CHARS = 50000;
  const text =
    transcript.length > MAX_CHARS ? transcript.slice(0, MAX_CHARS) : transcript;

  // Provider selection — defaults to OpenAI (cheapest GPT-4o-mini path).
  const provider = (env.LLM_PROVIDER || "openai").toLowerCase();
  let raw;
  if (provider === "anthropic") {
    raw = await summarizeWithClaude(text, durationSeconds, env);
  } else {
    raw = await summarizeWithOpenAI(text, durationSeconds, env);
  }
  if (!raw) return null;

  // Strip any stray markdown code fences the model might wrap around the JSON,
  // then parse safely.
  const cleaned = stripCodeFences(raw);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  // Validate the shape against the shared contract: exactly tldr/keyPoints/cheatSheet.
  if (
    !parsed ||
    typeof parsed.tldr !== "string" ||
    !Array.isArray(parsed.keyPoints) ||
    !Array.isArray(parsed.cheatSheet)
  ) {
    return null;
  }

  return {
    tldr: parsed.tldr,
    keyPoints: parsed.keyPoints,
    cheatSheet: parsed.cheatSheet,
  };
}

// Remove leading/trailing ```json ... ``` fences if the model added them.
function stripCodeFences(s) {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

// ---------------------------------------------------------------------------
// PROVIDER A (DEFAULT) — OpenAI GPT-4o-mini, cheapest path.
// Returns the raw model text (expected to be JSON) or null on failure.
// ---------------------------------------------------------------------------
async function summarizeWithOpenAI(transcript, durationSeconds, env) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(transcript, durationSeconds) },
      ],
      response_format: { type: "json_object" }, // ask for strict JSON
      temperature: 0.3,
      max_tokens: 1500,
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text : null;
}

// ---------------------------------------------------------------------------
// PROVIDER B — Anthropic Claude Haiku, trivial swap (set LLM_PROVIDER=anthropic).
// Returns the raw model text (expected to be JSON) or null on failure.
// ---------------------------------------------------------------------------
async function summarizeWithClaude(transcript, durationSeconds, env) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildUserMessage(transcript, durationSeconds) },
      ],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  // Anthropic returns a content array of blocks; grab the first text block.
  const block =
    Array.isArray(data?.content) &&
    data.content.find((b) => b && b.type === "text");
  return block && typeof block.text === "string" ? block.text : null;
}
