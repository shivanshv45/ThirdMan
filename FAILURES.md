# FAILURES

Every real breakage, logged as it happened rather than reconstructed afterwards.

These are the ones worth reading. Routine typos are not here; things that cost real time or changed an approach are.

---

## The worst one

### `audit_log` had no `merchant_id`, and leaked across tenants

- **Broke:** the audit trail lookup matched rows two ways: by the merchant's own money actions, OR by `money_action_id IS NULL`. Every merchant-less row showed up in *every* merchant's trail.
- **Cause:** the table had a nullable `money_action_id` but no `merchant_id` of its own, so a row with no linked money action had no way to be scoped to anyone. Invisible while one merchant existed, because "every merchant" and "the one merchant" were the same set.
- **Fix:** added a required `merchant_id`, backfilled it, threaded it through every call site. Added ownership checks to four dashboard mutations that had the same latent hole.
- **Lesson:** a code comment saying "this needs fixing if X is added" marks something that changes *correctness*, not scope. Single-tenant scaffolding hides its cross-tenant bugs in exactly the branches written to handle "no clear owner."

Every isolation test since proves scoping by **id enumeration**: actually attempting each read and mutation against a second merchant's real ids. Asserting an empty list stays empty would pass even if every ownership check were deleted.

---

## Google ADK and Gemini

### A Gemini quota failure is an event, not an exception

- **Broke:** a rate-limited buyer-agent run reported itself as `succeeded`.
- **Cause:** ADK surfaces a quota failure as a normal event carrying `errorCode`, not a thrown error. The `try`/`catch` around the loop never saw it.
- **Fix:** check `event.errorCode` explicitly, and treat a turn producing neither a tool call nor text as always an error, never a silent success.
- **Lesson:** a framework's error channel is not always the language's error channel. Check what an SDK actually emits on failure before trusting a `catch`.

### ADK re-resolves the entire tool list on every agent turn

- **Broke:** a handful of logical tool calls tripped our own MCP rate limiter (60/min).
- **Cause:** `MCPToolset` calls `getTools()` per turn, and each call opens its own session against our deliberately stateless transport. Together roughly **15x** the expected HTTP volume, purely from framework chattiness.
- **Fix:** resolve the toolset once per run and hand `LlmAgent` the resolved tools.
- **Lesson:** only visible against a real stateless server under real multi-turn load. A mocked transport would have shown nothing.

---

## Money and concurrency

### Reward coin redemption had a TOCTOU race, caught before shipping

- **Broke:** nothing, in production. Writing the required concurrency test made it obvious first.
- **Cause:** the first implementation read the balance, compared in application code, then inserted. Two concurrent redemptions could both pass the check and both write.
- **Fix:** made the ledger INSERT itself conditional, re-deriving the balance inside the same statement (`INSERT ... SELECT ... WHERE (SELECT SUM(...)) + delta >= 0`).
- **Lesson:** a balance modelled as an append-only ledger cannot reuse the "conditional UPDATE on a mutable column" recipe that `spend_caps` and `stock` use. Its atomicity has to be re-derived as a conditional INSERT against a live aggregate.

### The negotiation turn budget was off by one

- **Broke:** with a limit of 3, the buyer got a 4th counter before being refused.
- **Cause:** the check was `nextTurnCount > MAX`, which only fires at 4 when the count starts at 1.
- **Fix:** `>=`. The buyer's final allowed counter is now itself the turn that agrees or refuses.
- **Lesson:** `> MAX` reads correct on a skim and is wrong once you trace what the counter means on each call. Loop the exact number of times the contract promises and assert the last one is terminal.

### Real clock skew is real

- **Broke:** a model budget silently excluded real spend from its sum.
- **Cause:** it compared the app server's clock against the database's clock. Measured skew against our own Neon instance: roughly 500ms.
- **Fix:** every timestamp comparison in the runtime now uses `sql\`now()\``, the database's own clock.
- **Lesson:** "both clocks are basically the same" is an assumption, and it is measurable. Measure it.

### drizzle wraps the real Postgres error on `.cause`

- **Broke:** two concurrent requests with the same idempotency key both failed instead of one replaying the other's result.
- **Cause:** the code checked `err.code === "23505"`, correct for a raw postgres-js error. drizzle puts the real error on `err.cause`.
- **Fix:** check `err.cause?.code`. Confirmed by forcing a real duplicate insert and printing the whole error object rather than guessing.
- **Lesson:** do not assume a driver's error shape survives an ORM's wrapping. Print the object once and look.

---

## Security

### A login rate limit keyed by email is an account lockout

- **Broke:** anyone could lock a stranger out of their account by failing logins against their email.
- **Cause:** the pre-existing limiter keyed on email rather than client IP.
- **Fix:** re-keyed to IP.
- **Lesson:** found by a security review of the very layer that had just built a throttle *explicitly designed to avoid lockouts*. The new code was careful; the old code next to it was not, and nobody had looked.

### The chat model hallucinated a cart quantity

- **Broke:** the model's prose said "four bags" when the real, code-computed cart held two.
- **Cause:** the true number was handed to the model mid-paragraph, phrased as guidance. A small model weighted it loosely.
- **Fix:** isolate the number as its own `SYSTEM FACT` line, last in the prompt, stated as authoritative and final.
- **Lesson:** never a money-safety bug, since the UI renders the code-computed cart and never parses the model's sentence. But it erodes trust in a demo instantly. This fix has since been reused in three other subsystems rather than rediscovered.

---

## Deployment

### The env schema validated at import time, which broke the cloud build

- **Broke:** `next build` failed on Cloud Run with every required variable reported missing.
- **Cause:** `next build` statically collects page data, which runs module-level code that touches `env`, long before any request exists. A build stage legitimately has no runtime secrets.
- **Fix:** skip validation when `NEXT_PHASE === "phase-production-build"`, scoped narrowly enough that a served request always validates.
- **Lesson:** the first three attempts chased individual modules one crash report at a time. Worse, the local test looked like it passed because `next build` auto-loads `.env.local` from disk, so clearing the shell environment proved nothing. Verify a "works without config" claim by actually removing the config.

### Closing out real webhook delivery took four attempts, and the DB symptom was identical every time

- **Broke:** `webhook_events` stayed empty across four real payments, while checkout itself succeeded every time.
- **Cause:** four different misconfigurations in sequence: a typo'd path returning 404, a genuine secret mismatch returning 400, a URL saved as a bare host with the path dropped, and only then success.
- **Fix:** the tunnel's own request inspector, which showed the real paths and status codes.
- **Lesson:** the bare-host case is the nastiest, because `/` answered **200** and nothing looked wrong from the sender's side. Also: a successful checkout is no evidence the webhook works, because two independent confirmation paths converge on the same idempotent function. Only the audit reason naming the webhook proves which one ran.

---

## Things that recurred

### The same FK-ordering miss, six times

Cleanup deleting a parent before its children, across six separate layers. Each time the specific pair was different (`money_actions` before `audit_log`, then before `negotiations`, then `escalations`, and on).

- **Lesson:** the general rule was written down after the first one and it still recurred. A table with two outbound FKs has to out-order **both** parents, and a new table joins the graph in a direction older cleanup blocks never accounted for.

### A `@/` alias inside a dynamic `import()` fails under tsx, twice

- **Broke:** a stress test showed 0 allowed out of 20, looking like the gate was broken. The real error was `Cannot find package '@/lib'`.
- **Cause:** tsx resolves the `@/*` alias for static imports. A dynamic `import()` is resolved by Node, which has never heard of it.
- **Lesson:** it recurred in a new file two layers later, because the rule lived only in a past writeup. `tsc` and eslint do not catch it; only running the path does.

### A script with no `process.exit(0)` looks hung, not finished

- **Broke:** scripts printed their full correct output and never returned to the shell. Piping through `tail` made it look like a hang.
- **Cause:** the success path fell off the end while an open database pool kept the event loop alive.
- **Lesson:** fixed in three scripts, then found in **six more** during an audit six layers later, because the fix was never swept across the rest of the directory. A documented fix needs checking against every file with the same shape.

---

## Environment limits worth knowing

- **Razorpay test mode caps Payment Links at 30/day.** Undocumented in the SDK types, surfaced only at call time. Hit it during live iteration. The gate handled it correctly as a normal denial with a real reason, which is the contract working.
- **Groq's free tier is 200k tokens/day**, and this project's own no-mocks testing is the largest consumer. Exhausted twice. Both times the fallback degraded correctly and the test failure was downstream of correct behavior, not a break in it.
- **Neon can degrade mid-session.** A wave of FK-cascade cleanup failures once looked exactly like a regression. Reproducing against stashed code proved it was environmental. A single-query latency probe (8.8s, versus roughly 1s warm) settled it in seconds.

---

## Two that were only visible in a browser

- **A CSS reset silently disabled every Tailwind spacing utility site-wide.** Unlayered rules beat `@layer utilities`, so every `px-*`, `mt-*` and `mx-auto` in the entire app was dead, on the dashboard and storefront too.
- **A CORS preflight carries no body.** Putting the embed key in the JSON request rather than a header broke every real cross-origin call. Invisible locally, obvious the first time it ran on a real second domain.

---

## What this file is for

The application asks what broke and how we got out. These cannot be reconstructed convincingly later: a week on, the detail that made a bug interesting is gone, and a rebuilt story reads as invented.

So each one was written the day it happened, before moving on.
