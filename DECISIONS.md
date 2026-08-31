# DECISIONS

Design decisions that had real alternatives, and why this one won.

Only decisions where a reasonable engineer could have chosen differently are here. Anything with one sensible option is not a decision.

---

## The foundations

### Money is integer paise, everywhere

- **Options:** float rupees, a decimal type, integer paise.
- **Chose:** integer paise.
- **Because:** floats lose precision on arithmetic, and spend caps depend on exact comparisons. A cap breach that rounds the wrong way is a correctness failure, not a rounding artifact. The payment API uses paise natively, so there is no conversion at the boundary.
- **Cost:** every display point has to convert.

### AI decides judgment. Code decides limits.

- **Options:** let the model reason about caps holistically, or a hard split.
- **Chose:** the hard split. Models never compute or evaluate a bound.
- **Because:** a model cannot guarantee arithmetic, and "the model decided it was within budget" is not defensible to anyone. Bounds have to be provable.
- **Cost:** less flexible than a model weighing tradeoffs.

### The gate is a module every money action calls, not middleware

- **Options:** HTTP middleware on payment routes, an explicit module call, or database constraints.
- **Chose:** an explicit function call.
- **Because:** middleware only covers HTTP paths. It would miss webhook-triggered recovery and internal coin issuance, which are money actions too. An explicit call is greppable, so coverage is auditable. Database constraints cannot express a reason or produce an explanation.
- **Cost:** a new money action could forget to call it. Mitigated by making the gate the only module that touches the payment client.

### No mocks in the test suite

- **Options:** mock the SDK boundary to force failures deterministically, or provoke genuine ones.
- **Chose:** genuine failures only (an amount below the provider's minimum, an invalid model name).
- **Because:** a stress test caught a real bug, a dynamic import that silently failed to resolve, that a mocked suite could never have seen. The mock would have intercepted the call before module resolution mattered.
- **Cost:** slower runs, real API calls every time, and real daily quota consumption.

---

## Where money actually moves

### Checkout is the hosted widget, never server-side card capture

- **Options:** server-to-server card payments, or the hosted checkout.
- **Chose:** hosted. The server only creates an order and later verifies a signature.
- **Because:** taking card details directly brings PCI DSS scope and OTP/3DS handling this project has no business taking on. A client-reported success is never trusted either way: an HMAC check against the merchant's own secret is the actual proof, with the webhook as backstop.
- **Cost:** an external script client-side, and a three-step flow rather than one server call.

### The recovery pipeline is bounded by the same gate as any external buyer

- **Options:** give recovery a bypass (it is "the merchant," not an untrusted agent), give it an uncapped budget, or provision it a real capped agent row like anyone else.
- **Chose:** a real, hidden, per-merchant agent with its own spend cap, going through the identical gate.
- **Because:** a bypass would make the most interesting claim in the product ("the recovery agent is bounded by the same rules as everything else") untrue. It also means a cap-exhausted recovery attempt is an already-tested code path, not a new failure mode.
- **Cost:** an extra internal agent row per merchant that never appears in the dashboard's agent list.

### `recoveredPaise` lives on the attempt, not the failure

- **Options:** one column on the failure, or one per attempt, summed.
- **Chose:** on the attempt.
- **Because:** attribution needs to name *which* attempt recovered the money. Keeping it non-zero only on a succeeded outcome makes double-counting structurally harder: no code path both writes an amount and marks the attempt anything else.
- **Cost:** attribution needs a join rather than a flat read.

### Recovery Payment Links go through the gate, not around it

- **Options:** create an order through the gate purely for the audit trail and separately create the real link outside it, or extend the gate so it creates the link itself.
- **Chose:** the gate creates the link, reserving budget through the same bound checks.
- **Because:** two entities per attempt, an order nobody pays plus the link that is the real artifact, would be exactly the decorative money action this project forbids. It would also mean the audit trail's "what happened" no longer matches what the customer can pay.
- **Cost:** the settlement function branches on which kind of entity to create.

### Reward coins are a ledger, never a mutable balance column

- **Options:** a balance column updated in place, or an append-only ledger summed on read.
- **Chose:** the ledger. A balance is always the live SUM.
- **Because:** one number derived from evidence beats two numbers that can diverge, the same reasoning as `recoveredPaise` above.
- **Cost:** the standard "conditional UPDATE on a column" atomicity recipe does not transfer. Redemption needed a conditional INSERT re-deriving the sum in the same statement (see FAILURES.md, caught before shipping).

---

## Bounds and refusals

### Refunds and payouts are absent from the capability enum entirely

- **Options:** include them and never grant them, or leave them out of the enum.
- **Chose:** out entirely.
- **Because:** "we do not grant it" is a policy. "There is no value that could grant it" is a structural guarantee. No capability grant could ever expose a refund to an agent.
- **Cost:** an agent-initiated refund would need a schema change, deliberately.

### The returns desk has no auto-approval threshold

- **Options:** auto-approve small, clearly-eligible claims, or route every one to a human.
- **Chose:** every one, always.
- **Because:** a return is a conversation about money already banked. The model's one unilateral power points only in the safe direction: it can decline to forward an incoherent claim, and it can never approve.
- **Cost:** a merchant reviews claims that a threshold could have cleared. Recorded here explicitly so a future layer has to argue for changing it rather than quietly adding one.

### The negotiation floor is a merchant-authored price, not a margin derived from cost

- **Options:** derive the floor from cost plus a margin, or have the merchant state a price.
- **Chose:** a stated price.
- **Because:** a floor that refuses reveals *where* it is under repeated binary search. Sourcing it from a stated price means a successful probe reveals only what the merchant chose to state, never their actual margin. Capping counters at 3 makes the search impractical anyway.
- **Cost:** the merchant has to think about a number rather than a percentage.

### The Guardian baselines on a percentile, not a mean

- **Options:** mean plus standard deviation, or a percentile over the agent's own history.
- **Chose:** `percentile_cont` over each agent's trailing 14 days.
- **Because:** one outlier destroys a mean-based threshold, and an anomaly detector whose own threshold moves when it sees an anomaly is worse than none.
- **Cost:** raw SQL rather than an ORM helper, which brought its own bug (a raw `Date` in a `sql` template).

### ES256 for AP2 mandates, not Ed25519

- **Options:** Ed25519 (faster, simpler), or ES256.
- **Chose:** ES256.
- **Because:** AP2 forbids a deterministic signature scheme here. A deterministic signature would let an attacker build a rainbow table mapping known cart hashes to signatures. Non-obvious, and documented in the module itself so nobody "simplifies" it later.
- **Cost:** a heavier scheme than the obvious default.

---

## Being honest about what is real

### Layer 3's failed payments are simulated; everything downstream is real

- **Options:** fabricate the whole thing, block the layer until real checkout existed, or simulate only the failure.
- **Chose:** simulate the failure, keep diagnosis, policy, and execution entirely real.
- **Because:** blocking the highest-value layer on a lower-priority one would have meant several half-built layers instead of complete ones. Fabricating outcomes would have made the audit trail decorative.
- **Cost:** `recoveredPaise` was honestly always 0 in that layer, since nothing could verify a payment yet. Resolved later, when real Payment Links made it verifiable from a webhook. The `source` column is display-only and the pipeline never branches on it, so a real webhook and a simulated row take the identical path.

### The AI Treasury is a configurable mechanism, not a claim about anyone's economics

- **Chose:** state the constraint in the module's own docstring.
- **Because:** the allocation rate is a merchant-set parameter. Every figure the module produces still comes from a real query over real rows. "Simulation" means the rate is configurable, never that a number is invented.
- **Cost:** a less impressive-sounding headline than pretending the rate is derived.

### The landing page's refusal example is labelled illustrative

- **Options:** show a real audit row, invent one silently, or show one and say so.
- **Chose:** show one and label it.
- **Because:** an unauthenticated page has no merchant to scope real data to. The alternatives are fabricating silently or leaking a real tenant's data.
- **Cost:** one visible "illustrative" label on the marketing page. This is the only exception to the no-fabricated-data rule anywhere in the UI.

### Charts are gated on a real minimum before they render anything

- **Chose:** pure functions decide whether there is enough real activity, covered by property tests.
- **Because:** a dashboard drawing a confident curve through three points is lying about a business. Below the threshold it renders an explicit "not enough activity yet" state instead of a shape.
- **Cost:** a new merchant's dashboard looks emptier than a padded one would. Padding a sparse series with empty buckets cannot open the gate, and a property test asserts exactly that.

---

## Build and delivery

### Groq is the default, Gemini is reserved

- **Options:** Gemini default, Groq default, or route per task.
- **Chose:** Groq default, Gemini only for tasks that visibly need it, always with a Groq fallback.
- **Because:** Gemini's free tier rate-limits fast enough to break a live demo. Demo reliability outweighs per-call quality for classification and conversation, which is most calls.
- **Cost:** some reasoning-heavy tasks need prompt work to hold quality on Groq.

### This product ships its own MCP server rather than reusing the provider's

- **Because:** they solve opposite problems. The provider's server exposes *a merchant's own account operations to the merchant's own assistant*. This needs *a merchant's catalogue exposed to an external buyer's agent*. Different audience, different trust model, different tools.
- **Cost:** a hand-built server to maintain.

### The CLI links accounts with a pasted one-time token, not a browser callback

- **Options:** a full local-callback browser handoff, or a token the merchant pastes.
- **Chose:** the pasted token.
- **Because:** it gives the identical safety property, no password ever touches the terminal, for far less new infrastructure. Confirmed with the user as a real scope conversation rather than assumed.
- **Cost:** one extra copy-paste for the merchant.

### The CLI's audit duplicates the server's scoring rather than sharing it

- **Options:** extract one shared scorer, or deliberately duplicate.
- **Chose:** duplicate, initially.
- **Because:** the two run against fundamentally different evidence: real files on disk versus real database rows. A shared abstraction would have had to pretend those are the same thing.
- **Cost:** two scorers to keep aligned. Later revisited: the *predicates* both audits judge with now live in one shared module, so the Instant Audit and the CLI cannot silently diverge. The scoring wrappers stayed separate.

### The Shopify app is custom and unlisted, not App Store published

- **Because:** App Store review is a real gate outside this project's control. A custom app installed on a real development store exercises every identical code path: real OAuth, real Admin API, real token exchange.
- **Cost:** no public listing. Claimed as exactly what it is, never as a published app.

### Cloud Scheduler drives the runtime, and there is no worker process

- **Options:** a long-running worker, the host's own cron, or an external scheduler.
- **Chose:** an external scheduler hitting one authenticated endpoint.
- **Because:** a durable task is a row, claimed atomically. Cloud Run scales to zero and runs nothing between requests, so without an external tick the backoffs and sweeps never fire. The tightest bound in the system is 5 minutes, so a per-minute tick keeps every sweep inside its own deadline rather than at it.
- **Cost:** one more piece of infrastructure that has to actually be running.

---

## Design

### Dark, cool, and deliberately not the payment provider's brand

- **Because:** the product's job is counting things precisely and occasionally refusing a lot of money. The palette's one real spine is the allow / deny / escalate triad, matching the schema's own enum, rather than a decorative accent color.
- **Cost:** none worth naming. It is also deliberately away from the generic indigo-on-dark that reads as machine-generated.

### Every number renders in a monospaced font with tabular figures

- **Because:** money, ids, SKUs and counts all need to line up and be comparable at a glance. No component anywhere renders a money figure in a proportional font.
