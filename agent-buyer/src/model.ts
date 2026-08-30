/**
 * Pinned model id, same discipline model-pricing.ts applies to its own
 * rate table (src/lib/model-pricing.ts in the parent app) — a fixed
 * constant with a comment recording when it was verified live, not a
 * "latest" alias that can silently drift underneath a recorded demo.
 *
 * Verified live 2026-08-30 against the real Gemini API (models.list()
 * plus a real generateContent smoke call) — satisfies the Google
 * hackathon's "Gemini 3.5+" requirement.
 *
 * gemini-3.5-flash's free tier caps at 20 requests/minute and a real
 * daily quota, both observed exhausted live on 2026-08-30 by this
 * package's own multi-turn test runs (see FAILURES.md). THIRDMAN_MODEL_ID
 * overrides this for local iteration against a sibling model with
 * separate quota (e.g. gemini-3.5-flash-lite, also 3.5+) — never used
 * silently; the default recorded here is what a real run and the demo
 * video should use.
 */
export const BUYER_MODEL_ID = process.env.THIRDMAN_MODEL_ID?.trim() || "gemini-3.5-flash";
