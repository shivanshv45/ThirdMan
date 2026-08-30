# thirdman

A merchant's own codebase auditor. Run it in your store's repo and it tells you what an AI buyer can and cannot do with your store today — read from your real product data, your real page markup, your real routes — then offers to write the integration as a diff you approve.

Built for [Thirdman](../plans/layer-20-merchant-cli.md), a merchant-side agentic commerce platform. This is a standalone package: no import of the main app's `src/lib`, no database connection of its own.

## Install and run

```
cd cli
npm install
node bin/thirdman.js init --root /path/to/your/store
```

(Once published, this will be `npx thirdman init` with no local install.)

## Commands

- **`thirdman init`** — the full flow: detect your stack, run the audit, show a before/after score, then offer to write the discovery document, a config file, and an embed snippet — every write shown as a unified diff, confirmed individually. `--dry-run` audits and writes nothing.
- **`thirdman audit`** — read-only. Detect and report, write nothing, exits non-zero below `--threshold`, so it fits in CI.
- **`thirdman doctor`** — verify an existing integration still works: is the script tag present, does the discovery document resolve over HTTP, does a linked agent key still authenticate.

## The governing rule

**The tool reads freely and writes only what you have seen and approved, file by file.**

- Reading is unrestricted within the project directory (excluding `node_modules`, `.git`, build output, and anything your own `.gitignore` already excludes).
- Every write is shown as a unified diff and requires an explicit "yes" — there is no flag that skips this.
- The tool never writes outside the project root, never touches `.git`, and never modifies a file it did not just show you.
- No credential is ever written to a file the tool creates. An agent API key goes only to `.env.local`, and only after verifying `.env.local` is covered by your `.gitignore` — refusing, loudly, if it isn't (`scripts/demo-failure-cli-refuses-unsafe-write.ts` in the parent repo demonstrates this).

## What it checks

A weighted checklist over your real repo — discoverability (a `/.well-known/agent-commerce.json`, `robots.txt` not blocking AI crawlers, a sitemap, `schema.org/Product` structured data), machine-readability of your catalogue (locatable product data, prices as real numbers not formatted strings, a stable SKU per variant), transactability (no CAPTCHA/OTP gate before checkout, a real API surface), and integration state (is the embed snippet already installed). Every failed check names what to fix and, where one exists, the real file it found the problem in.

## What it does not do

- No autonomous refactor — it adds discovery metadata and an integration snippet, never restructures your components or checkout.
- No model call ever produces a number, a price, a URL, or a file path — every fact in the audit is a deterministic check against something really on disk.
- No network write on your behalf without a separate confirmation — creating an agent key or updating your allowlist is a real change to your account.
- No fabricated score — every point traces to a named check that passed or failed against a real file.

## Development

```
npm run typecheck
npm run test
```

Tests are real fixtures on disk (a temp directory per test, `test-fixture.ts`), never mocks — the audit's checks, stack detection, snippet idempotency, and the `.env.local` safety refusal are all exercised this way.
