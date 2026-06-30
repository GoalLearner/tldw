# TLDW — Too Long; Didn't Watch

TLDW is a dead-simple YouTube video summarizer. Paste a YouTube link and it fetches the
video's transcript, sends it to an LLM, and hands back a short **TL;DR**, a list of **key
points**, and a scannable **cheat sheet** — so you can skip the watch. It's built to be
tiny and readable: a vanilla-JS frontend, a single zero-dependency Cloudflare Worker, and a
D1 database that caches every summary. Caching plus per-IP rate limiting keep running costs
down near zero.

## Setup

1. **Get a free Supadata API key** at [supadata.ai](https://supadata.ai). The free tier
   includes **100 requests/month**, which is plenty for personal use. (Supadata is used to
   pull transcripts — YouTube blocks datacenter/cloud IPs, so we can't scrape them from the
   Worker directly.)

2. **Get an OpenAI API key** at [platform.openai.com](https://platform.openai.com). The
   default model is `gpt-4o-mini` (cheapest). Optionally also get an **Anthropic API key**
   at [console.anthropic.com](https://console.anthropic.com) if you want to use Claude
   instead (see "Switching AI provider" below).

3. **Install Wrangler and log in:**
   ```bash
   npm install -g wrangler
   wrangler login
   ```

4. **Create the D1 database, wire up the id, and load the schema:**
   ```bash
   wrangler d1 create tldw-cache
   ```
   Copy the `database_id` it prints and paste it into `wrangler.toml` (the
   `database_id = "REPLACE_WITH_ID_FROM_wrangler_d1_create"` line). Then create the table:
   ```bash
   wrangler d1 execute tldw-cache --file=schema.sql
   ```
   Add `--local` (e.g. `wrangler d1 execute tldw-cache --local --file=schema.sql`) if you
   also want the table in the local dev database.

5. **Set your secrets** (these are NOT stored in `wrangler.toml` — never commit API keys):
   ```bash
   wrangler secret put SUPADATA_API_KEY
   wrangler secret put OPENAI_API_KEY
   wrangler secret put ANTHROPIC_API_KEY   # optional, only if using the Anthropic provider
   ```

   > **Local testing note:** `wrangler secret put` sets secrets on the **deployed**
   > Worker. For local `wrangler dev`, put the same keys in a **`.dev.vars`** file
   > instead (copy `.dev.vars.example` → `.dev.vars` and fill it in). `.dev.vars` is
   > gitignored, so your keys never get committed. Without it, local runs will report
   > "no transcript" because the API keys are missing.

6. **Run it locally, then ship it:**
   ```bash
   wrangler dev      # test locally at the printed localhost URL (reads .dev.vars)
   wrangler deploy   # publish to your Cloudflare account (uses `wrangler secret` values)
   ```

## Costs & free-tier limits

This app is designed to run for almost nothing:

- **Supadata:** 100 free transcript requests/month. Upgrade your plan at
  [supadata.ai](https://supadata.ai) if you outgrow it.
- **OpenAI:** pay-as-you-go; `gpt-4o-mini` is the cheapest option. Manage billing at
  [platform.openai.com](https://platform.openai.com).
- **Cloudflare Workers + D1:** both have generous free tiers that comfortably cover personal
  use. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) to
  upgrade if needed.

**Caching + rate limiting keep costs near zero.** Every summary is cached in D1, so the
second time anyone summarizes the same video it's served instantly from the database with
**no Supadata or LLM call at all**. Per-IP rate limiting caps runaway usage. In practice an
**uncached** video costs roughly **1–3¢** (one Supadata call + one LLM call); a **cached**
video is **free**.

## Switching AI provider

The provider is controlled by the `LLM_PROVIDER` var in `wrangler.toml`:

```toml
[vars]
LLM_PROVIDER = "openai"   # "openai" | "anthropic"
```

Set it to `"anthropic"` to summarize with Claude instead of OpenAI (make sure
`ANTHROPIC_API_KEY` is set). No other code changes needed — the two `summarizeWithOpenAI` /
`summarizeWithClaude` functions in `src/worker.js` are kept as clean swappable seams.

## Customizing the summaries (finance niche)

The summarization prompt lives entirely in **`src/prompt.js`** (`SYSTEM_PROMPT` and
`buildUserMessage`), deliberately isolated from the Worker logic. To specialize TLDW for a
niche — e.g. a finance-focused summarizer — edit that one file. That's the whole reason the
prompt and the `summarize` functions are kept separate and swappable.
