# ARCHITECTURE

What exists, how it's wired, and the contracts later layers depend on. Updated whenever schema, endpoints, or module boundaries change — see [CLAUDE.md](CLAUDE.md).

## Module map

```
src/lib/env.ts          — the only file that reads process.env directly.
                           Everything else imports { env } from here.
                           (drizzle.config.ts is the one other sanctioned
                           exception — it runs outside the app's module graph.)

src/lib/db/
  schema.ts              — Drizzle table definitions, the single source
                           of truth for the data model.
  index.ts                — db client (postgres-js + drizzle), exports
                           { db, schema }.

src/lib/audit.ts         — logAuditEntry(), getRecentAuditEntries().
                           The only way to write an audit_log row.

src/lib/razorpay.ts      — createOrder, fetchOrder, fetchPayment,
                           validateCredentials, capturePayment,
                           refundPayment, createPaymentLink,
                           fetchPaymentLink (Layer 4-2/4-3). The only way
                           to reach the Razorpay SDK. Every function takes
                           a RazorpayCredentials (a merchant's own key
                           id/secret) and builds its own client — no
                           shared singleton, since each merchant has a
                           different key pair (Layer 2-2). Throws
                           RazorpayCallError, distinguishing an
                           API-level rejection (isRazorpayError: true,
                           carries razorpayCode) from a network/timeout
                           failure. createOrder's autoCapture flag
                           (default true) is what makes an order
                           auto-capture on payment vs. the escrow flow's
                           payment_capture: false.

src/lib/payment-verify.ts — verifyCheckoutSignature(). HMAC-SHA256 over
                           "<order_id>|<payment_id>" with the merchant's
                           key secret — the proof a Razorpay Checkout
                           success callback is real, not just a
                           client-reported "it worked." Same
                           timingSafeEqual discipline as webhook-verify.ts,
                           kept separate since the signed inputs differ
                           (two plain fields vs. an arbitrary raw body).

src/lib/storefront.ts    — getOrCreateStorefrontAgent(). A human buyer on
                           the public storefront isn't an AI agent, but
                           the gate requires an agents.id for its bound
                           checks — this provisions a hidden, per-merchant
                           "__storefront_checkout" agent with its own
                           spend cap, same pattern as
                           recovery/sequencer.ts's getOrCreateRecoveryAgent.
                           Never returned by the dashboard's agent list.

src/lib/storefront-catalogue.ts — getPublicCatalogue(), getPublicProduct(),
                           getMerchantStorefrontInfo(). Public-safe
                           catalogue reads for the storefront (Layer 4-2)
                           and the agent-facing GET /api/agent/products
                           (Layer 4-4) — deliberately never returns
                           costPaise, which is internal-only. Restructured
                           in Layer 5-1: a PublicProduct now carries a
                           variants[] array (sku, pricePaise, stock,
                           availability, attributes, gtin/mpn, imageUrl)
                           instead of a flat price/stock — a product with
                           zero active variants is filtered out entirely
                           rather than shown unbuyable.

src/lib/escrow.ts        — sweepExpiredHolds(). The escrow demo's bound
                           (Layer 4-5): auto-refunds any hold past its
                           deterministic expiry, called from
                           /dashboard/escrow on load. A refund that
                           genuinely fails (Razorpay down, credentials
                           disconnected) leaves the hold "held" for the
                           next sweep to retry, rather than marking it
                           resolved when it wasn't.

src/lib/chat.ts          — handleChatTurn(), getConversationState(),
                           newSessionToken() (Layer 4-6, restructured
                           Layer 5-7). The buyer chat's AI/code split:
                           classifyIntent() asks the model for a
                           structured proposal (add/set/remove, grounded
                           in the real catalogue given in the prompt) via
                           completeStructured(), then applyIntent()
                           re-validates it against the real catalogue and
                           writes conversations.cartProductId/cartVariantId/
                           cartQuantity in code — the model's proposal is
                           advisory only. resolveProductByName (Layer 5-7)
                           now matches against variant-level entries: an
                           exact SKU match first, then name, then a
                           word-overlap score computed against a display
                           name that folds in distinguishing attribute
                           values (describeVariant()) — so "the 250g
                           ethiopia" resolves by attribute, not just name
                           string overlap, and the cart holds a specific
                           variant, not just a product's default one. The
                           reply-generation call is handed the
                           code-computed cart as an isolated "SYSTEM FACT"
                           line and told the number is authoritative; see
                           FAILURES.md for the bug this fixed (a small
                           model paraphrasing a fact given mid-paragraph
                           into a wrong number). The cart is still
                           single-line (one product+variant+quantity) — a
                           genuine multi-line cart remains a real, noted
                           gap (plans/layer-5-agent-readable-catalog.md).

src/lib/catalogue-import.ts — parseCsv(), extractFromPastedText(),
                           importCatalogueRows(), getImportHistory()
                           (Layer 5-2). parseCsv is pure and deterministic
                           (no LLM — a model silently dropping a row is a
                           data-integrity bug nobody would notice).
                           extractFromPastedText asks the model to
                           structure a merchant-pasted blob via
                           completeStructured(). Neither function writes
                           to the database — both return an
                           ImportPreview the merchant reviews and edits
                           client-side; importCatalogueRows is the only
                           writer, idempotent by (merchantId, sku): a
                           matching SKU updates the existing variant
                           rather than creating a duplicate. One
                           catalogue_imports row per import run, summary
                           counts only, not one row per product.

src/lib/mcp-server.ts    — createMcpServerForAgent() (Layer 5-4, extended
                           Layer 6-3/6-5). This product's own MCP server,
                           not Razorpay's — see DECISIONS.md for why they
                           solve opposite problems. Builds a fresh
                           McpServer instance per request, scoped to one
                           already-authenticated agent, exposing eleven
                           tools: list_products, get_product,
                           search_products (deterministic substring/word-
                           overlap match, no LLM), check_availability,
                           get_merchant_policy, get_spend_status,
                           get_offers/purchase (purchase accepts either a
                           sku or an offerId), and get_reward_balance/
                           redeem_reward_coins. purchase calls
                           attemptMoneyAction() unchanged — no second
                           money path, whether buying a variant, a bundle
                           offer, or redeeming coins. Every tool result is
                           a successful JSON payload describing
                           allow/deny/escalate, never a protocol-level
                           error, same "a denial is HTTP 200" contract as
                           the REST agent API.

src/lib/agent-readiness.ts — computeReadiness(), getAgentReadiness()
                           (Layer 5-6). A deterministic checklist over
                           real data — every check a named, weighted, pure
                           predicate in one ordered array, no model
                           involved, score an integer percentage. Each
                           failed check carries a specific fix message and
                           deep link, not a generic nag.
src/lib/trust-score.ts    — computeTrustScore(), getTrustScore() (Layer
                           25-3). Mirrors agent-readiness.ts's shape for a
                           per-agent trust figure — named weighted
                           components over real counts, no model. NEVER
                           imported by gate.ts; see
                           trust-score-never-influences-gate.test.ts.
src/lib/bound-simulator.ts — simulateBoundChange() (Layer 25-1). Replays
                           real recorded audit_log attempts against a
                           hypothetical cap, in sequence, calling gate.ts's
                           own exported checkCapArithmetic() — never a
                           second implementation of the cap rules.
src/lib/decision-share.ts — createDecisionShareToken(),
                           resolveShareToken(), revokeDecisionShareToken()
                           (Layer 25-4). An explicit, revocable,
                           unguessable per-decision share token backing
                           /why/[id]'s one public-access path.
src/lib/description-suggestion.ts — suggestProductDescription() (Layer
                           5-6). The one genuinely good LLM job in the
                           readiness scorer: drafts a description for a
                           thin/missing one from a product's real
                           name/category/attributes via Groq. Never writes
                           to the database — the caller shows it as a
                           draft the merchant copies into the product edit
                           form, same proposal-not-decision pattern as
                           catalogue-import.ts and chat.ts.

src/lib/policy-text.ts   — describeMerchantPolicy() (Layer 5-3). Derives a
                           human-readable sentence from the structured
                           merchant_policies fields, for display only —
                           the reverse (storing prose, asking a model to
                           extract terms at read time) is deliberately
                           not done, since it would put a model between a
                           buyer agent and a contractual term.

src/lib/discount.ts      — resolveOffer(), acceptOffer(), declineOffer(),
                           loadOfferItems(), sweepExpiredOffers() (Layer
                           6-1). The only place a discounted amount is
                           computed — re-derives the expected charge from
                           a merchant-authored bundle's own price, never
                           trusts anything a caller asserts. gate.ts's
                           checkBounds compares the caller's amountPaise
                           against this with the identical deny-on-
                           mismatch discipline resolveVariant already
                           uses. See "The offer engine" below.

src/lib/bundles.ts       — createBundle(), archiveBundle(),
                           getMerchantBundles(),
                           getMerchantVariantsForBundling() (Layer 6-1).
                           Merchant-authored bundle CRUD — the only writer
                           of bundles/bundle_items. Enforces a maximum
                           discount percent and a cost floor (a
                           below-cost bundle needs explicit
                           belowCostAcknowledged) before a bundle row can
                           exist at all.

src/lib/offer-engine.ts  — runOfferEngine(), getOpenOfferForIdentity()
                           (Layer 6-2). Code computes eligibility and the
                           margin floor (bundlePricePaise minus summed
                           real costPaise) BEFORE any candidate reaches
                           the model — a below-floor bundle never appears
                           in the model's input. Only the filtered set
                           (capped deterministically) goes to Groq via
                           completeStructured, which ranks one or
                           explicitly declines all of them; a model
                           failure degrades to no offer, never to a
                           denied purchase. Every run writes one
                           offer_decisions row, whether or not it
                           produced an offer — see "The offer engine"
                           below.

src/lib/reward-coins.ts  — getRewardSettings(), computeCoinsToIssue(),
                           coinsToValuePaise(),
                           maxRedeemableCoinsForPurchase(),
                           getCoinBalance() (Layer 6-5). Pure integer
                           arithmetic — the coin-to-paise conversion, the
                           issuance rate, and the redemption ceiling. No
                           model anywhere near it. A balance is always the
                           live SUM of reward_coin_ledger's deltas, never
                           a cached column — same reasoning as
                           recoveredPaise living on the recovery attempt
                           rather than the failure (DECISIONS.md).

src/lib/reward-actions.ts — issueRewardCoinsForCapture(),
                           redeemRewardCoins(), getRewardBalance() (Layer
                           6-5). Both money-moving functions call
                           attemptMoneyAction() with a new rewardLedger
                           field — no second money path for coins.
                           Issuance is idempotent by the originating
                           purchase's own money_action id (confirmCapture
                           has two independent success paths that can
                           both trigger it). See "The offer engine" below
                           for the redemption concurrency guarantee.

src/lib/explainability.ts — getUnifiedDecisions(), getDecisionStats(),
                           getDecisionById(), getDecisionForMoneyAction()
                           (Layer 7). Reads across four existing sources —
                           audit_log denials, escalations, offer_decisions
                           non-offers, and recovery_attempts/audit_log
                           stops — into one normalised UnifiedDecision
                           shape (source, kind: "refusal"|"deferral",
                           determinism: "deterministic"|"model_influenced",
                           the verbatim recorded reason, and structured
                           arithmetic, never prose). Writes nothing and
                           decides nothing — see "The explainability
                           layer" below. Every bound-label mapping is
                           explicit; an unrecognised boundApplied/event
                           renders visibly as unmapped rather than
                           silently as "Other".
src/lib/explain-decision.ts — explainDecision() (Layer 7). The one
                           legitimate LLM job in this layer: explains one
                           already-recorded UnifiedDecision in plain
                           language via completeStructured (Groq). Every
                           number the model may reference is handed as an
                           isolated, explicitly-labelled fact line — the
                           same isolated-SYSTEM-FACT fix chat.ts's Layer
                           5-7 paraphrasing bug required (FAILURES.md),
                           reused here rather than rediscovered. Never
                           persisted anywhere; degrades to
                           { available: false } on any model failure,
                           never a crash — a third fail-closed flavour
                           alongside the gate's (deny) and the offer
                           engine's (no offer): here, closed means show
                           the complete recorded truth without the
                           plain-language layer.

src/lib/negotiation.ts   — openNegotiation(), submitBuyerCounter(),
                           getOpenNegotiationForIdentity(),
                           resolveNegotiation(), markNegotiationRedeemed(),
                           getNegotiationTranscript(),
                           sweepExpiredNegotiations() (Layer 8). Code
                           decides whether a variant is negotiable at all,
                           whether a buyer's counter clears the floor, and
                           the exact concession price each turn
                           (computeConcessionCeiling — pure arithmetic,
                           the recovery pipeline's backoff-schedule
                           precedent). The model is asked only to phrase
                           an already-decided counter as a sentence;
                           submitBuyerCounter reassigns the price from the
                           code-computed ceiling unconditionally after the
                           model call, so nothing in the model's response
                           can ever move the number a buyer is offered.
                           The floor and cost are never in the model's
                           prompt. A model failure degrades to the
                           deterministic counter (a plain templated
                           sentence at the same price), never a crash or a
                           wider allowance — a fourth fail-closed flavour
                           alongside the gate's (deny), the offer engine's
                           (no offer), and the explainer's (raw record).
                           See "The negotiation layer" below.

src/lib/rate-limit.ts    — checkRateLimit() (async), getClientIp(),
                           sweepStaleRateLimitWindows(). Postgres-backed
                           (Layer 26-1, replacing the earlier in-memory
                           Map): one atomic INSERT ... ON CONFLICT DO
                           UPDATE ... WHERE upsert per (key, quantized
                           window), the same conditional-write discipline
                           reserveBudget/reserveStock/claimDueTasks
                           already prove correct under concurrency.
                           Genuinely shared across instances. See
                           "Hardening (Layer 26)" below.

src/lib/login-throttle.ts — checkLoginThrottle(), recordLoginFailure(),
                           clearLoginThrottle(), requiredDelaySeconds()
                           (pure). Per-account exponential backoff,
                           deliberately not a lockout (Layer 26-3). See
                           "Hardening (Layer 26)" below.
                           Applied to /api/chat, /api/checkout/order,
                           /api/checkout/verify, /api/agent/purchase, and
                           the login Server Action.

src/lib/crypto.ts        — encrypt(), decrypt(). AES-256-GCM via Node's
                           crypto, for merchant secrets at rest
                           (currently: Razorpay credentials). The only
                           file that touches createCipheriv/createDecipheriv.
                           Format: "iv:tag:ciphertext", base64 segments.
                           Tampered ciphertext throws on decrypt rather
                           than silently yielding garbage.

src/lib/llm.ts           — complete(), completeStructured().
                           The only way to call an LLM. Groq by default,
                           Gemini only on needsHardReasoning, NVIDIA/
                           OpenRouter/Z.ai only on an explicit `provider`
                           field (Layer 16) — all three via one shared
                           OpenAI-compatible HTTP caller, no new SDKs.
                           Every non-default provider always falls back
                           to Groq on failure.

src/lib/model-pricing.ts — real, sourced per-token pricing for every
                           routable model, computeCallCostPaise(),
                           providerForModel() (Layer 16). Integer paise
                           only. An unpriced model throws rather than
                           costing zero.

src/lib/model-router.ts — routeCompletion(), setModelBudget(),
                           setUseCaseProvider() (Layer 16),
                           getUseCaseBudgetStatus(), getRoutingSavings().
                           Per-use-case AI budgets and provider routing,
                           funded from the treasury.

src/lib/model-armor.ts  — inspectInbound(), inspectOutbound() (Layer 16).
                           Deterministic-first inspection around a model
                           call. May only block, never approve.

src/lib/runtime/
  tasks.ts               — createTask(), claimDueTasks(), recordStep(),
                           rescheduleTask(), completeTask(), abandonTask(),
                           cancelTask(), retryTask() (Layer 17). The
                           durable task state machine. No worker process —
                           advanced by /api/cron/run's tick, one row per
                           unit of long-running work.
  runner.ts               — drainDueTasks(), createRecoverySequenceTask()
                           (Layer 17). Trigger-agnostic drain plus the
                           recovery_sequence kind's step handler.

src/lib/memory/
  derived.ts               — recomputeDerivedMemory() (Layer 18). Pure
                           deterministic queries over tables already
                           owned — prior purchases, reward balance, past
                           negotiation outcomes, outstanding restock
                           requests. costPaise/margin never read in.
  stated.ts                — extractCandidateMemories(),
                           parseCandidateMemory(), writeStatedMemory(),
                           confirmStatedMemory() (Layer 18). The
                           reward-rules.ts draft/validate/confirm
                           pipeline applied to something a buyer said.
                           Nothing auto-confirms.
  retrieve.ts               — getMemoryFactsForSubject(),
                           renderMemoryFactBlock(), deleteMemory(),
                           correctMemory(), sweepExpiredMemories()
                           (Layer 18). Fixed per-key templates only — a
                           stored value is never concatenated raw into a
                           prompt.

agent-buyer/              — (Layer 19) a standalone TypeScript package,
                           OUTSIDE src/ and outside this app's build/test
                           run — its own package.json, tsconfig.json,
                           vitest config. The autonomous, external,
                           untrusted AI buyer agent: imports nothing from
                           src/lib/*, holds no DATABASE_URL, talks to the
                           product exclusively over its real MCP endpoint
                           and one real agent API key. See "The
                           Adversarial Buyer and the Theatre" below.
  src/env.ts               — its own separate env schema (THIRDMAN_BASE_URL,
                           THIRDMAN_AGENT_KEY, GEMINI_API_KEY only).
  src/model.ts             — BUYER_MODEL_ID, pinned, verified-live-dated,
                           overridable via THIRDMAN_MODEL_ID for local
                           iteration against a model with separate quota.
  src/bounds.ts             — checkCeilings(), DEFAULT_RUN_BOUNDS. This
                           agent's own deterministic step/purchase/time/
                           rate-limit-retry ceilings — code, never the
                           model it's built around.
  src/mcp-client.ts         — createBuyerToolset(): a @google/adk
                           MCPToolset over Streamable HTTP, Bearer-
                           authenticated exactly like any other agent
                           integration.
  src/loop.ts               — runBuyerAgent(): the multi-turn agentic
                           loop (Google ADK's LlmAgent + Runner), every
                           tool call gated by beforeToolCallback/
                           afterToolCallback against bounds.ts's
                           ceilings, every step appended to a local
                           JSONL run log (run-log.ts).
  src/upload.ts             — uploadRunLog(): streams the local run log
                           to /api/agent/theatre/ingest once a run ends.
                           Best-effort; never changes the run's own
                           outcome.

cli/                      — (Layer 20, package name "thirdman") a
                           standalone TypeScript package, OUTSIDE src/
                           and outside this app's build/test run — its
                           own package.json, tsconfig.json, vitest
                           config, published separately. A merchant's
                           own codebase auditor: reads a real repo,
                           scores AI-buyer-readiness, writes generated
                           files only after a shown diff is confirmed.
                           No database connection of its own. See "The
                           merchant CLI" below.
  src/fs-scope.ts           — ProjectScope: the one class every read and
                           write in this package goes through. resolve()
                           throws on any path outside the project root;
                           listFiles()/isExcluded() enforce node_modules/
                           .git/build-output/gitignored exclusion.
  src/secrets.ts            — envLocalIsGitignored(),
                           writeAgentKeyToEnvLocal(),
                           UnsafeSecretWriteError. The governing rule's
                           credential check: refuses to write a secret
                           to .env.local unless it's really gitignored.
  src/stacks/detect.ts       — detectStack(): evidence-based only, never
                           a directory-name guess. Reports
                           ambiguousWith rather than picking when two
                           stacks both match real evidence.
  src/checks/*.ts            — the weighted audit checklist (discoverability,
                           machine-readable, transactability, integration),
                           mirroring agent-readiness.ts's AuditCheck shape
                           deliberately, duplicated rather than shared —
                           see DECISIONS.md.
  src/generate/*.ts          — diff.ts (planWrite/applyWrite, the
                           unified-diff-then-confirm pipeline), snippet.ts
                           (the idempotent, marker-based embed injector),
                           discovery-doc.ts, config.ts.
  src/prompter.ts            — Prompter interface; realPrompter (backed
                           by the `prompts` package) vs. scriptedPrompter
                           (tests) — the interactive layer is injectable
                           so init.ts is testable without a real TTY.
  src/link.ts                — redeemLinkToken(): the CLI's half of
                           account linking, POST /api/cli/link.
  src/commands/{init,audit,doctor}.ts — the three thirdman subcommands.

src/lib/cli-link.ts       — createCliLinkToken(), redeemCliLinkToken(),
                           sweepExpiredCliLinkTokens() (Layer 20-6). The
                           app's half of account linking: a single-use,
                           10-minute token a merchant generates on
                           /dashboard/cli and pastes into the CLI —
                           never a password. Redemption creates one
                           agent (products:read + purchase:create only)
                           and optionally adds one origin to the embed
                           allowlist, both audited.

src/lib/gate.ts          — attemptMoneyAction(), resolveEscalation(),
                           confirmCapture(), captureHeldPayment(),
                           issueRefund(), sweepAbandonedReservations()
                           (Layer 4-2/4-3/4-5/23-2). THE spine.
                           The only path to a money action in the whole
                           codebase. See "The gate contract" below.

src/lib/risk.ts          — computeRiskSignals(), assessRisk(),
                           deterministicFallback(). The judgment layer
                           inside the gate. Can only downgrade an allow
                           to pending_escalation, never produce a deny.

src/lib/agent-auth.ts    — authenticateAgent(), extractBearerKey(),
                           hashApiKey(), generateApiKey(),
                           recordCatalogueRead() (Layer 23-3). The only
                           place the api-key hashing scheme (SHA-256) and
                           raw-key format (sk_<24 random bytes, base64url>)
                           are defined — used by both the agent API's
                           authentication path and dashboard-mutations.ts's
                           createAgent()/rotateAgentKey().

src/lib/password.ts      — hashPassword(), verifyPassword(). scrypt-based,
                           no framework dependency, so scripts (e.g.
                           scripts/seed.ts) can hash a password without
                           pulling in next/headers.
src/lib/auth.ts          — createSession(), destroySession(),
                           getSessionMerchant(), requireSessionMerchant().
                           Re-exports password.ts's two functions. Owns the
                           session cookie via next/headers, so only usable
                           inside a Next.js request scope. DB-backed
                           sessions (the `sessions` table), not JWTs — a
                           session is revoked by deleting its row.
src/proxy.ts             — optimistic auth redirect only (cookie presence,
                           no DB call — Proxy runs on every prefetched
                           route). The real check is in each page via
                           getSessionMerchant()/requireSessionMerchant().
                           This Next.js version renamed middleware.ts to
                           proxy.ts — see node_modules/next/dist/docs.

src/lib/dashboard.ts             — read queries for the merchant dashboard,
                                    every function scoped by merchantId.
src/lib/dashboard-mutations.ts   — framework-agnostic write logic (setSpendCap,
                                    revokeAgent, reactivateAgent, createAgent,
                                    rotateAgentKey, connectRazorpay,
                                    disconnectRazorpay, createProduct,
                                    updateProduct, archiveProduct,
                                    reactivateProduct), kept separate from
                                    the Server Action wrappers so it's
                                    testable without a Next.js request context.
                                    Every mutation touching an existing agent
                                    or product verifies it belongs to the
                                    calling merchant first (requireOwnedAgent(),
                                    requireOwnedProduct()).

src/app/dashboard/agent-key-reveal.tsx — client component (useActionState)
                                    for the one moment a raw agent API key
                                    is shown — held in component state,
                                    never re-sent by the server after the
                                    initial reveal.
src/app/dashboard/audit-trail.tsx — client component for the audit trail.
                                    Refresh re-fetches via the
                                    refreshAuditTrail() Server Action and
                                    swaps entries into state (useTransition),
                                    no full page reload. Each row shows only
                                    the decision and the reason sentence by
                                    default; the technical fields (event
                                    code, bound_applied, money-action
                                    type/status/order id) are behind a
                                    per-row "Show details" toggle.

src/lib/webhook-verify.ts — verifyWebhookSignature(). HMAC-SHA256 over
                           the exact raw request body (never a
                           re-serialised JSON.stringify), timingSafeEqual
                           compare. The only file that computes a webhook
                           signature — used by /api/webhooks/razorpay.

src/lib/recovery/
  intake.ts               — recordPaymentFailure(). The single writer of
                             payment_failures rows, used by both the
                             webhook and the demo batch loader — neither
                             writer is special-cased downstream. Idempotent
                             on (merchant_id, razorpay_payment_id) via a
                             partial unique index, so a webhook redelivery
                             can't double-count.
  demo-batch.ts            — loadDemoFailureBatch(). Merchant-triggered,
                             not a hidden job. Writes source: "simulated"
                             rows spanning every decline category and
                             amount band the policy needs to branch
                             differently on.
  diagnose.ts              — diagnoseFailure(). A closed DeclineCategory
                             enum the model picks from, never invents. A
                             deterministic lookup table over known
                             Razorpay decline codes is checked first;
                             only codes it doesn't cover reach the model
                             (Groq). Fails closed to
                             category: "unknown"/recoverable: false on
                             any model failure.
  policy.ts                — shouldAttemptRecovery(), chooseStrategy(),
                             expectedValuePaise(), nextAttemptTime().
                             Zero model calls, zero I/O — pure functions
                             over plain inputs. Every bound the recovery
                             agent operates under (attempt ceiling, ROI
                             governor, backoff schedule, high-value
                             human-escalation threshold) lives here as a
                             named exported constant.
  sequencer.ts             — runRecoveryForFailure(), runRecoveryBatch().
                             Orchestrates; decides nothing — every
                             decision comes from diagnose.ts or policy.ts.
                             Money-moving strategies call
                             attemptMoneyAction() through a lazily
                             provisioned per-merchant recovery agent, so
                             a recovery attempt is bounded by the same
                             spend cap and gate as any external buyer
                             agent. recoveredPaise is only ever set from
                             a verified fetchOrder() result, never from
                             an order merely having been created. Batches
                             run sequentially, not Promise.all, since
                             attempts share one spend cap.
  attribution.ts           — getRecoveryStats(), getFailureQueue(). Read-
                             only, merchant-scoped SQL aggregation, no
                             model. Sums exclusively from
                             recovery_attempts.recovered_paise — never
                             re-derived from money_actions, so there is
                             one number, not two that can diverge.

src/app/api/agent/*      — the headless agent API: status, purchase (v2,
                           Layer 4-4 — productId/quantity or the original
                           amountPaise+context, plus holdOnly for escrow),
                           actions/[id], products (Layer 4-4 — the
                           agent-readable catalogue, GET only).
src/app/api/checkout/order/route.ts — creates a real Razorpay order for a
                           human buyer on the public storefront (Layer
                           4-2), through the gate via the hidden
                           storefront agent. Public, rate-limited.
                           Extended Layer 6-3: accepts either productId
                           (a single variant) or offerId+sessionToken (a
                           bundle upsell) — an offerId path accepts the
                           offer then charges the gate the bundle's own
                           merchant-set price, never a client-supplied
                           amount.
src/app/api/checkout/verify/route.ts — verifies the Checkout signature
                           the browser hands back and calls
                           gate.confirmCapture() (Layer 4-2). Public,
                           rate-limited. The proof, not the client's
                           report of success. Extended Layer 6-5: on a
                           genuine capture (never a hold), calls
                           reward-actions.ts's issueRewardCoinsForCapture()
                           — a failure there never affects the checkout's
                           own response.
src/app/api/checkout/hold-order/route.ts — the escrow demo's entry point
                           (Layer 4-5): merchant-only (session auth),
                           creates a real order with holdOnly: true.
src/app/api/checkout/decline-offer/route.ts — a buyer declining an
                           upsell offer (Layer 6-3). No money moves, so
                           this doesn't touch the gate — only updates the
                           offer's own status.
src/app/api/checkout/redeem-coins/route.ts — redeems reward coins as
                           their own gated money action (Layer 6-5),
                           standalone rather than folded into a purchase's
                           price — see DECISIONS.md.
src/app/api/chat/route.ts — the buyer chat's only endpoint (Layer 4-6).
                           Public, no auth, rate-limited — delegates
                           entirely to src/lib/chat.ts.
src/app/store/[merchantId]/manifest.json/route.ts — the public,
                           unauthenticated agent-discovery manifest
                           (Layer 5-5, extended Layer 21-2): merchant
                           info, a catalogue summary (counts, categories,
                           price range — already-public storefront
                           prices, not a new disclosure), the policy
                           summary sentence, how to reach this merchant's
                           MCP server/agent API, the closed capability
                           enum (refunds/payouts absent from it entirely,
                           surfaced as a fact an agent can read), the
                           merchant's agent terms (or an honest
                           "unpublished" state), and its AP2/x402
                           protocol support — see below. Rate-limited by
                           IP (reuses rate-limit.ts). Linked from the
                           storefront page's <head> via generateMetadata()
                           — a <link rel="alternate"> and a custom
                           agent-manifest meta tag — so a crawler or
                           agent landing on the storefront URL can find
                           it. Body assembled by src/lib/discovery-
                           manifest.ts's buildMerchantManifest(), shared
                           with the .well-known route below so the two
                           documents can't drift on what "this merchant's
                           capabilities" means.
src/app/.well-known/agent-commerce.json/route.ts — the conventional
                           discovery location at the origin root (Layer
                           21-1), where a crawler or agent probes first.
                           Since this deployment is genuinely multi-tenant
                           on one origin, this is honestly a DIRECTORY —
                           every connected merchant, each pointing at its
                           real per-merchant manifest above — not a
                           resolution to one "default" merchant, which
                           would misrepresent a multi-tenant deployment
                           as single-tenant. See DECISIONS.md. The
                           per-merchant manifest's own URL is unchanged
                           and keeps working on its own.
                           Protocol posture, precisely: this product
                           implements a documented SUBSET of AP2
                           (Checkout/Payment Mandate verification as
                           ES256-signed JWTs — see mandates.ts — not the
                           full W3C Verifiable Credential/SD-JWT stack
                           with selective disclosure) and a documented
                           subset of x402 (a 402 Payment Required
                           challenge shape on an unauthenticated
                           /api/agent/purchase request — see below — not
                           a full payment-settlement flow). ACP and
                           NPCI's UAP are NOT implemented and not
                           claimed, named in the manifest only as
                           context. See DECISIONS.md.
src/app/api/mcp/route.ts — this product's own MCP server (Layer 5-4),
                           Streamable HTTP (POST/GET/DELETE), agent-key
                           bearer-authed. Stateless: no sessionIdGenerator,
                           a fresh McpServer built per request so there is
                           no server-side session state to leak between
                           agents. Rate-limited per agent id.
src/app/api/webhooks/razorpay/route.ts — Razorpay's webhook intake.
                           Verifies the signature over the raw body
                           before parsing anything; an unverifiable
                           signature writes nothing. Idempotent by
                           Razorpay's own x-razorpay-event-id, claimed in
                           webhook_events before any side effect runs
                           (Layer 4-2). Handles payment.failed (feeds the
                           recovery pipeline), payment.captured/order.paid
                           (calls gate.confirmCapture(), the backstop for
                           /api/checkout/verify), and payment_link.paid
                           (calls recovery/sequencer.ts's
                           confirmRecoveryLinkPaid() — Layer 4-3).
                           Resolves the merchant by matching the payload's
                           order id back to money_actions.razorpay_entity_id.
src/app/dashboard/*      — the merchant dashboard (page.tsx + Server Action wrappers).
                           Resolves the merchant from the session, not a
                           hardcoded row — see "Merchant auth" below.
src/app/dashboard/products/* — merchant catalogue CRUD (Layer 4-1): list,
                           add, inline-edit, archive/reactivate. The only
                           way a product exists outside scripts/seed.ts.
                           Also shows the storefront link (Layer 4-2).
src/app/dashboard/offers/* — the upsell offer/refusal log and bundle
                           management (Layer 6-1/6-4): the stats headline
                           row (runs/offered/accepted/declined/**no
                           offer**, the refusal count as a headline
                           number), the merchant's bundle list with a
                           creation form built from the real catalogue,
                           and the recent-decisions log showing every
                           engine run including refusals with their exact
                           arithmetic.
src/app/dashboard/rewards/* — the reward-coin program's dashboard surface
                           (Layer 6-5): ledger stats (issued/redeemed/
                           outstanding, summed live) and the merchant's
                           rate/ceiling settings form. No settings row
                           means rewards are off, not a permissive
                           default.
src/app/dashboard/escrow/* — the escrow demo's dashboard surface (Layer
                           4-5): trigger a real hold via a real Checkout
                           payment, view every hold (held/captured/
                           refunded/expired_refunded), release or refund
                           a held one. Sweeps expired holds
                           (escrow.sweepExpiredHolds()) on every page load.
src/app/dashboard/recovery/* — the recovery pipeline's dashboard surface
                           (page.tsx, actions.ts, failure-queue.tsx).
                           Same conventions as the rest of the dashboard:
                           server component reads, thin Server Action
                           wrappers over framework-agnostic recovery/*
                           functions, merchant re-derived from the
                           session in every action. Shows a pending
                           attempt's real, clickable Payment Link URL
                           (Layer 4-3).
src/app/store/[merchantId]/* — the public storefront (Layer 4-2/4-6):
                           page.tsx (product grid + BuyButton, a real
                           Razorpay Checkout flow), chat-widget.tsx (the
                           buyer chat, Layer 4-6). No auth — anyone with
                           the URL can browse and buy. Not linked from
                           /proxy.ts's protected-route matcher.
src/app/signup/*         — merchant signup page + Server Action.
src/app/login/*          — merchant login page + Server Action, rate-limited by email.

src/lib/test-helpers.ts  — createTestMerchant(), for tests/scripts that
                           only need a valid merchant row to attach other
                           rows to (satisfies the required email/passwordHash
                           columns with placeholder values).

shared/store-readiness-checks.ts — the one file both the Instant Audit
                           and cli/'s audit engine import for the
                           *judgment* half of "is this store agent-
                           ready" (Layer 24-11): robotsBlocksAgents(),
                           sitemapReferencesProducts(),
                           hasProductStructuredData(),
                           hasStableItemIdentifier(),
                           checkoutRequiresHumanOnlyStep(),
                           priceLooksLikeFormattedString(). Pure, no
                           network/filesystem/model — evidence-gathering
                           still differs by caller (HTTP fetch vs. a
                           filesystem read), only these predicates are
                           shared, by plain relative import rather than
                           a package boundary.
src/lib/store-checks.ts  — the Instant Audit's own StoreCheck shape and
                           computeStoreScore(), re-exporting the shared
                           predicates above (Layer 24-1).
src/lib/store-fetch.ts   — fetchPage(), AuditFetchBudget,
                           isPathDisallowedByRobots() (Layer 24-1). The
                           fetching discipline: robots.txt respected,
                           hard timeout/page-count/byte-count budget
                           shared across one audit run, fetch-only, no
                           form ever followed, no page retained past
                           the run that fetched it.
src/lib/store-audit.ts   — runInstantAudit() (Layer 24-1): orchestrates
                           store-fetch.ts + store-checks.ts into one
                           public, unauthenticated report, cached by URL
                           for 10 minutes (instant_audit_cache).
src/app/api/audit/route.ts — the Instant Audit's public endpoint, IP
                           rate-limited (5/min).
src/app/api/audit/artifacts/route.ts — L24-5's session-gated endpoint:
                           a failed check id in, an exact paste-able
                           artifact out, for this merchant's own
                           publishable key.
src/lib/integration-artifacts.ts — artifactsForReport() (Layer 24-5):
                           turns a failed Instant Audit check into the
                           exact block to paste and where.
src/lib/unsupported-platform-spec.ts — generateUnsupportedPlatformSpec()
                           (Layer 24-6): a precise spec for a human
                           developer to implement and review — never a
                           prompt for an AI to edit a live store
                           unsupervised.
src/lib/woocommerce-plugin.ts — generateWooCommercePluginForMerchant()
                           (Layer 24-4): one complete, pre-configured
                           .php file per merchant, merchant id and
                           publishable key baked in. Proxies the real
                           live discovery manifest through WordPress's
                           own hooks (never a static copy), injects the
                           widget via wp_footer, adds schema.org/Product
                           JSON-LD read from WooCommerce's own product
                           object at render time. Idempotent on
                           re-activation, removes cleanly on
                           deactivation.
src/lib/shopify.ts       — the Shopify app (Layer 24-3): beginShopifyInstall()/
                           completeShopifyInstall() (a real OAuth2
                           install, single-use state row rather than a
                           cookie — the redirect crosses into the
                           merchant's own Shopify admin and back),
                           fetchShopifyCatalogue()/confirmShopifySync()
                           (Admin API → the same importCatalogueRows()
                           write path csv/pasted_text already use — a
                           new source, never a new writer),
                           sweepExpiredShopifyInstallStates(). Only
                           read_products is ever requested. Built as a
                           custom/unlisted app on a real dev store — see
                           DECISIONS.md.
src/app/api/shopify/install/route.ts — GET, requireSessionMerchant()
                           then a top-level redirect to the shop's own
                           /admin/oauth/authorize (same reasoning as
                           /api/auth/[provider]/start — a consent screen
                           refuses to render inside a fetch).
src/app/api/shopify/callback/route.ts — GET, Shopify's redirect back
                           with a code; fails closed to a dashboard
                           redirect with a reason on any invalid/expired/
                           reused state, matching /api/auth/[provider]/
                           callback's own posture.
src/app/dashboard/integrations/* — Shopify connect, the WooCommerce
                           download, copy-paste artifacts, and the
                           unsupported-platform spec — four delivery
                           surfaces over the same underlying engines
                           (Layer 24-3/4/5/6).
src/lib/setup-conversation-schema.ts — the zod-validated closed shape a
                           drafted agent-fleet proposal must satisfy
                           (Layer 24-7).
src/lib/setup-conversation.ts — draftSetupProposal() (Layer 24-7): the
                           one model call this feature makes — turns a
                           merchant's plain-English instruction into a
                           proposal (name, purpose, a capped budget with
                           a stated reason, the minimum capability set
                           for the job). Zero import of
                           setup-conversation-confirm.ts, asserted
                           statically by setup-conversation.isolation.test.ts
                           — the fifth instance of this codebase's
                           model-holds-no-pen structural proof.
src/lib/setup-conversation-confirm.ts — confirmSetupProposal() (Layer
                           24-7): the only function that writes
                           agents/spend_caps/agent_capabilities rows
                           from this flow. Nothing is created until one
                           explicit confirmation; the whole batch is
                           created together or not at all.
src/lib/shadow-mode.ts   — enableShadowMode()/disableShadowMode()/
                           getShadowModeState() (Layer 24-8). A
                           presence table (merchant_shadow_mode) —
                           checked directly inside gate.ts's
                           attemptMoneyAction(), which forces
                           dryRun: true, shadowModeForced: true onto
                           every request for a shadow-mode merchant
                           before checkBounds ever runs, regardless of
                           what the caller passed. Not a UI convention:
                           no code path from a shadow-mode merchant
                           reaches executeAndSettle. See the gate
                           contract.
src/lib/integration-verify.ts — the dashboard's on-demand "did it
                           actually work" checks (Layer 24-9): origin
                           allowlisted, discovery document resolving,
                           MCP handshake succeeding — thirdman doctor's
                           own checks, surfaced without a terminal.
src/lib/onboarding-defaults.ts — seedOnboardingDefaults() (Layer 24-10):
                           a new merchant's real, clearly-labelled-as-
                           default starting spend cap and policy — a
                           real row the merchant can see and change,
                           never a fabricated metric.
vscode-extension/src/diagnostics.ts — turns a real cli/src AuditCheck
                           finding into a Problems-panel diagnostic
                           anchored to a real file position (Layer
                           24-2). Imports cli/src/types.ts directly —
                           never a forked copy of the CLI's own
                           judgment.
```

**Rule for every layer from here on:** feature code imports `gate.ts` for any money action, never `razorpay.ts` directly. Everything else follows the same import discipline as Layer 0 — no route, script, or component reaches into `razorpay`, `groq-sdk`, `@google/generative-ai`, or the DB driver directly.

## Data model

Defined in `src/lib/db/schema.ts`. All money columns are **integer paise**. All timestamps UTC. All primary keys UUID.

```
merchants ──┬── products ── product_variants ── bundle_items
            ├── agents ──── spend_caps ──── escalations
            ├── sessions
            ├── audit_log
            ├── payment_failures ──── recovery_attempts
            ├── bundles ──── offers ──── offer_decisions
            ├── merchant_reward_settings
            ├── reward_coin_ledger
            ├── negotiations ── negotiation_turns
            ├── conversations ──┬── cart_items
            │                   └── cart_purchases ── cart_purchase_items
            └── money_actions ──┬── audit_log
                    ▲            ├── escalations
                    │            ├── recovery_attempts (opt)
                    │            ├── offer_id → offers (opt)
                    │            ├── negotiation_id → negotiations (opt)
                    │            ├── cart_id → cart_purchases (opt)
                    │            └── reward_coin_ledger (opt)
                    └── agents (opt)
```

- **`merchants`** — a real account: `email` (unique) and `passwordHash` (scrypt, `salt:hash` hex). `razorpayKeyIdEncrypted`/`razorpayKeySecretEncrypted` hold the merchant's own Razorpay test-mode credentials, AES-256-GCM encrypted via `crypto.ts` (Layer 2-2). Both nullable — a merchant can sign up before connecting an account, and the gate treats "not connected" as a deny, not an error.
- **`sessions`** — a logged-in merchant session: `merchantId`, `expiresAt`. DB-backed rather than a JWT, so a session is revoked by deleting its row.
- **`products`** — the marketing-level entity (Layer 5-1): `name`, `description`, `category` (closed enum), `subcategory` (free text). `status` (`active`/`archived`) — archived, never deleted, so a product referenced by a past `money_actions` row keeps its history; archived products don't appear in the catalogue or accept purchases. Money and stock moved to `product_variants` in Layer 5-1 — see DECISIONS.md for the variants-as-child-table choice.
- **`product_variants`** — the sellable unit (Layer 5-1): `sku` (unique per merchant), `pricePaise`, `costPaise`, `stock`, `availability` (`in_stock`/`out_of_stock`/`preorder`/`discontinued` — derived from stock where possible but merchant-overridable), `attributes` (flat string→string jsonb, e.g. `{"size":"250g"}`), optional `gtin`/`mpn`/`imageUrl`. `merchantId` is denormalised from the parent product so SKU uniqueness and every merchant-scoped agent-facing query don't need a join. `stock` is written exclusively by the gate, via the same atomic conditional-`UPDATE` pattern `spend_caps.spentPaise` uses. A product with exactly one variant (the common case) is the dashboard's one-form fast path — see "The merchant dashboard" below. `floorPricePaise`/`belowCostFloorAcknowledged` (Layer 8) — the merchant-authored negotiation floor; null means the variant is not negotiable at all, never a permissive default.
- **`agents`** — an external AI buyer. `api_key_hash` stores a SHA-256 hash; the raw key is never persisted (`scripts/seed.ts` generates a random key per agent, persists it locally to a gitignored file for dev convenience, and never hardcodes one). `catalogue_read_count` (Layer 23-3) — a running lifetime counter, incremented by `agent-auth.ts`'s `recordCatalogueRead()` on every real catalogue read; paired with a live count of the agent's own `money_actions` rows to compute a read-to-purchase ratio (`guardian.ts`'s `computeReadPurchaseRatio()`). Never resets, never decays — see "What's deliberately not here yet." `registration_source` (Layer 21-8, enum `merchant_issued`/`self_registered`, defaulting `merchant_issued` so every pre-existing row is unaffected) and `registered_ip` (nullable, set only for a self-registered row) — metadata about how the row came to exist, not a separate trust tier: a self-registered agent is checked against `merchant_agent_terms` (below) in `checkBounds`, but is otherwise an ordinary row through the identical gate.
- **`spend_caps`** — the bound. Models UPI Reserve Pay: authorise once, spend within a window, capped by both a running total (`spent_paise` vs `cap_paise`) and a per-transaction ceiling (`per_transaction_max_paise`). **`spent_paise` is written exclusively by the gate, via an atomic conditional update.**
- **`money_actions`** — every attempt to move value, allowed or denied, with a status lifecycle (`allowed`/`pending_escalation` → `executed` → `held`/`captured`/`failed`, or `denied`). `idempotency_key` is nullable, unique per agent via a partial index (`WHERE idempotency_key IS NOT NULL`), letting a repeated agent request replay its original outcome instead of double-charging. `checkout_mandate_id` (nullable, Layer 21-4) — set only when this action was taken under a verified AP2 Payment Mandate, the id of the exact `checkout_mandates` row consumed; the caller (the purchase route, the MCP `purchase` tool) sets it right after `verifyPaymentMandate()` succeeds, never re-derived from timing. `null` is the common case (mandates are opt-in) and must always render as an honest "no mandate," never ambiguous — see `mandates.ts`'s `getMandateProofForMoneyAction()`. `product_id` (nullable, Layer 4-1) — set only when the request named a catalogue product; escrow, recovery retries, and payouts leave it null. `variant_id` (nullable, Layer 5-1) — the specific variant purchased; this, not `product_id`, is what the gate actually resolves price/stock against and reserves/releases stock for. Both columns are populated together on a variant purchase (`product_id` derived from the variant's own `productId`) — `product_id` was never repurposed so pre-Layer-5 rows keep pointing at something valid. `quantity` defaults to 1 and is only meaningful alongside `variant_id`. `razorpay_payment_id` (Layer 4-2) — the payment id that actually paid the order, set once a capture is confirmed; distinct from `razorpay_entity_id`, which holds the order id (or, for a recovery Payment Link, the link id — see below). `hold_only` (Layer 4-5) — true only for escrow: the order was created with `payment_capture: false`, so a verified payment lands as `held`, not `captured`. `negotiation_id` (nullable, Layer 8) — set when the purchase redeemed an agreed negotiated price, populated alongside `variant_id` the same way `offer_id` is. `cart_id` (nullable, Layer 9-close-out) — set when the purchase checked out a genuine multi-item cart; points at a frozen `cart_purchases` snapshot, never at the live `cart_items` rows (see below). Mutually exclusive with `variant_id`/`offer_id`/`negotiation_id` — the gate denies a request naming more than one. **`executed` means an order/link exists — an intent to collect. `captured` means money actually arrived. Never conflate the two** — see the gate contract's point 9 below. `reservation_expires_at` (nullable, Layer 23-2) — set only while a row sits at `status: "allowed"` (budget and stock reserved, execution not yet resolved), to a deadline computed from the database's own clock; `null` at every other time, including on every terminal status. See the gate contract's point 17 and `sweepAbandonedReservations()`.
- **`escalations`** — a money action the risk layer flagged instead of executing. Holds `risk_reason` and an `outcome` (`pending`/`approved`/`rejected`), resolved by a merchant via `resolveEscalation()`, which now also checks the escalation's money action belongs to the calling merchant.
- **`audit_log`** — one row per decision. `reason` is free text and is the field a judge reads; it's enforced non-empty by `logAuditEntry`'s runtime check, not just by schema. `money_action_id` is nullable — a denial doesn't always warrant a `money_actions` row. **`merchant_id` is required and set on every write** — added in Layer 2-1 after discovering the original nullable-`money_action_id` design let merchant-less rows (denials before a `money_actions` row exists) leak into every merchant's audit trail via an `OR isNull(...)` clause. See FAILURES.md.
- **`webhook_events`** — one row per Razorpay webhook event actually processed (Layer 4-2), keyed by Razorpay's own `x-razorpay-event-id` header via a unique index. Claimed (inserted) before any side effect runs; a redelivery hits the unique-index conflict and is acknowledged as a no-op rather than repeating work — the generalised version of `payment_failures`' own partial unique index, covering every event type this app handles, not just failures.
- **`escrow_holds`** — one row per escrow hold (Layer 4-5), referencing the `money_actions` row it tracks. `expires_at` is the deterministic bound that stops a hold from stranding a buyer's money indefinitely (`ESCROW_HOLD_EXPIRY_HOURS` in `gate.ts`, currently 48h); `outcome` (`held`/`captured`/`refunded`/`expired_refunded`) records how it was resolved. Modelled explicitly in schema rather than inferred from Razorpay's own state, so a held payment is always visible and actionable from `/dashboard/escrow`, never a support ticket waiting to happen.
- **`payment_failures`** — one row per payment that did not succeed (Layer 3). `source` (`webhook`/`simulated`) is display-only — the recovery pipeline must never branch on it, which is what lets a merchant's demo batch exercise the exact same code a real webhook delivery would. `diagnosis` (jsonb) is written once by `diagnoseFailure()` and cached — a failure is diagnosed at most once, not re-diagnosed on every recovery pass. Unique on `(merchant_id, razorpay_payment_id)` where the payment id is set, so a webhook redelivery can't create a duplicate.
- **`recovery_attempts`** — one row per recovery attempt (Layer 3). Two FKs out: `payment_failure_id` (always) and `money_action_id` (only for strategies that moved money — its presence is the proof an attempt actually passed through the gate). `razorpay_payment_link_id`/`payment_link_url` (Layer 4-3) — set when the attempt created a real, payable Razorpay Payment Link; the webhook's `payment_link.paid` handler matches back on the link id. `outcome` can be `pending` — a link is paid asynchronously, so a successfully-created link is neither success nor failure yet, just not-resolved-yet. `recovered_paise` is **only ever non-zero when `outcome = "succeeded"`**, and `"succeeded"` is only ever set by `confirmRecoveryLinkPaid()` from a verified webhook amount — never from a link merely having been created. Both FKs must be respected in cleanup/delete order (see FAILURES.md).
- **`conversations`** / **`chat_messages`** (Layer 4-6) — the buyer chat's state, keyed by a browser-generated `session_token` rather than any account (the storefront has no buyer login).
- **`cart_items`** (Layer 9-close-out — replaces the single-line `cart_product_id`/`cart_variant_id`/`cart_quantity` columns previously on `conversations`) — the buyer chat's real, live, multi-item cart: one row per distinct variant a conversation has added, unique on `(conversation_id, variant_id)`. Written exclusively by code (`src/lib/cart.ts`, called from `src/lib/chat.ts`), never directly by the model — see "The buyer chat" below. A line leaves the cart by row deletion; there is no "quantity: 0" state.
- **`cart_purchases`** / **`cart_purchase_items`** (Layer 9-close-out) — a frozen snapshot of a cart at the exact moment a purchase was attempted through the gate, referenced by `money_actions.cart_id`. `cart_items` itself stays live and buyer-editable after checkout (the buyer can keep shopping), so a `money_actions` row can never point at it directly — it needs its own permanent record of what was actually bought, at what price, the same freezing reason `negotiations` copies `catalogue_unit_price_paise` at open time rather than re-reading `product_variants` later.
- **`merchant_policies`** (Layer 5-1 schema, wired in Layer 5-3) — one row per merchant, structured return/refund/shipping terms (`returnsAccepted`, `returnWindowDays`, `refundMethod` enum, `restockingFeePercent` integer 0-100, `shippingRegions` text array, `handlingTimeDays`, `warrantyMonths`, `policyNotes` — the one free-text field, for humans only, never parsed by an agent). No row means the merchant has genuinely not published a policy — never a fabricated permissive default. `setMerchantPolicy()` (`dashboard-mutations.ts`) upserts and clears `returnWindowDays`/`refundMethod` when `returnsAccepted` is set false, so those fields never go stale.
- **`catalogue_imports`** (Layer 5-1 schema, wired in Layer 5-2) — one row per confirmed CSV/paste import run, written by `catalogue-import.ts`'s `importCatalogueRows()`. An unconfirmed preview (parsed or extracted but never confirmed) leaves no row here — there's nothing to show a merchant about an import that never happened.
- **`bundles`** / **`bundle_items`** (Layer 6-1) — a merchant-authored discount definition: a name, an integer-paise `bundlePricePaise`, `belowCostAcknowledged` (only true when the merchant explicitly confirmed selling below the summed item cost), and the member variants+quantities in `bundle_items`. The only source of truth for a discounted amount — `discount.ts`'s `resolveOffer()` reads this, never trusts a caller's asserted price.
- **`offers`** (Layer 6-1) — one row per offer actually made to a buyer (agent or session, never both), referencing the `bundles` row it discounts. `status` (`offered`/`accepted`/`declined`/`expired`) and a real, code-checked `expires_at`. `money_actions.offer_id` (nullable, new column, never repurposing `product_id`/`variant_id`) points here when a purchase redeemed one.
- **`offer_decisions`** (Layer 6-4) — one row per offer-engine run, whether or not it produced an offer — the refusal log. `eligible_candidate_count`/`below_margin_floor_count` are the exact arithmetic that produced the outcome; `offered_offer_id` is null with a `no_offer_reason` set on a deliberate refusal. Deliberately not `audit_log` — no money moved yet at decision time, and overloading the money audit trail with non-money events would make it harder to read for what it's actually for.
- **`merchant_reward_settings`** (Layer 6-5) — one row per merchant: `paisePerCoin`, `issueRatePermille`, `maxRedemptionPercent`. No row means rewards are off — same "absence is real, not a default" discipline as `merchant_policies`.
- **`reward_coin_ledger`** (Layer 6-5) — append-only. `coinsDelta` positive on issue, negative on redemption, never zero. A balance is always the live `SUM` of a buyer identity's rows here, never a cached column — a redemption's atomicity is enforced by making the `INSERT` itself conditional on that live sum via raw SQL, not by a second mutable balance column (see "The offer engine" below and FAILURES.md). Every row's `money_action_id` FKs to a real, gated `money_actions` row — a ledger entry cannot exist without one.
- **`negotiations`** (Layer 8) — one row per negotiation, doubling as the redeemable artifact once `status` reaches `agreed` (no separate "agreed price" table — see DECISIONS.md). `catalogueUnitPricePaise`/`floorUnitPricePaise` are frozen at open time, copied from the variant's own price/floor rather than re-read later, so a merchant changing the floor mid-negotiation can't move the goalposts on one already open. `agreedUnitPricePaise` is null until `status: "agreed"` and is never written any other way. `buyerTurnCount` is the real, code-enforced anti-probing bound (`MAX_BUYER_COUNTERS`, `negotiation.ts`). `agentId`/`sessionToken` — whichever buyer identity is negotiating, never both, same convention as `offers`.
- **`negotiation_turns`** (Layer 8) — one row per exchange, the transcript a merchant reads. Cannot live in `audit_log`, since `logAuditEntry` never throws into a money path and a failed write is silently swallowed — a transcript needs a reliable home. `offeredUnitPricePaise` is null on a merchant turn generated by the deterministic-degrade path (no model call made).
- **`embed_configs`** (Layer 10) — one row per merchant, `merchant_id` as the primary key (no separate `id`, same shape as `merchant_policies` — never more than one). `publishable_key` (`pk_...`) is stored **in plaintext** — deliberately, unlike `agents.api_key_hash`, since it's printed verbatim into public HTML by design and hashing it would buy nothing. `allowed_origins` (text array, normalised on write) is the origin bound; empty means "not configured," enforced as a deny by `embed.ts`'s `isOriginAllowed()`, never as "allow everything." `accent_color` is validated as a real hex colour before it's ever stored. `features` (jsonb) holds real on/off switches only (`negotiation`, `offers`) for capability that already exists elsewhere — never a flag for behaviour that isn't built.
- **`merchant_webhooks`** (Layer 10) — a merchant-registered outbound endpoint. `secret_encrypted` is genuinely secret (it signs every delivery) and AES-256-GCM encrypted via `crypto.ts`, same as `merchants.razorpayKeySecretEncrypted` — unlike the embed's publishable key, this one is shown to the merchant exactly once at registration.
- **`webhook_deliveries`** (Layer 10) — the durable outbound queue; a row exists **before** any HTTP call is attempted, which is what makes a crashed process recoverable rather than a silently dropped notification. `payload` is the exact bytes signed and sent (never re-serialised at send time). A partial unique index on `(webhook_id, event_type, money_action_id) WHERE money_action_id IS NOT NULL` makes enqueueing idempotent against `confirmCapture`'s two independent success paths — the same partial-unique-index pattern `payment_failures` already established, generalised to a different table.
- **`rate_limit_windows`** (Layer 26-1) — the distributed rate limiter's shared state. One row per `(limit_key, window_start)`, unique-indexed on that pair — the atomic upsert `checkRateLimit` performs contends on this index, never a read-then-write. Swept by `/api/cron/run`'s `rate-limit:sweep-stale` job once a window is old enough nothing will query it again.
- **`login_throttle_state`** (Layer 26-3) — one row per email that has ever failed a login, `email` as the primary key. `failedAttempts`/`lastFailedAt` feed `requiredDelaySeconds()`'s pure backoff curve; a decayed row (past `DECAY_WINDOW_MS`) is treated as no state at all on read, and reset to `failedAttempts: 1` on the next write past decay — never accumulates toward a permanent lock. Cleared entirely on a successful login.
- **`merchant_agent_terms`** (Layer 21-7) — one row per merchant, `merchant_id` as the primary key (no row means unpublished — self-registration closed, unknown agents not allowed, the conservative reading of every field, same "absence is real" discipline as `merchant_policies`). Every field is arithmetic or a boolean: `unknownAgentsAllowed`/`newAgentOrderCeilingPaise` (checked only for `registrationSource: "self_registered"` agents), `mandateRequiredAbovePaise` (checked for any agent), `negotiationOpenToAgents`, `selfRegistrationOpen`/`selfRegisterStartingCapPaise`/`selfRegisterPerTransactionMaxPaise`/`selfRegisterDefaultCapabilities` (the self-registration configuration L21-8 reads). `setMerchantAgentTerms()` refuses to persist `selfRegistrationOpen: true` without both cap fields set.
- **`shopify_connections`** (Layer 24-3) — one row per installed shop. `merchant_id` and `shop_domain` are each independently unique-indexed: one Shopify store per Thirdman account, and one Thirdman account per Shopify store — a shop already connected elsewhere is refused at install rather than silently reassigned (`completeShopifyInstall`'s `shop_already_connected` outcome). `access_token_encrypted` is AES-256-GCM via `crypto.ts`, the same treatment as `merchants.razorpayKeySecretEncrypted` — an offline Admin API token is exactly that class of secret. `last_synced_at` is null until the merchant's first confirmed catalogue sync, stamped by `confirmShopifySync()`, never assumed fresh.
- **`shopify_install_states`** (Layer 24-3) — the install flow's CSRF state, `state` as the primary key. A row rather than a cookie, unlike every other single-use token in this codebase (`cli_link_tokens`, `decision_share_tokens`) — Shopify's OAuth redirect passes through the merchant's own Shopify admin and back, a different browser context than the one that started the flow, so a same-origin cookie set here isn't guaranteed to survive the round trip. Deleted on redemption (single-use, same discipline as `cli_link_tokens`) and swept when abandoned-and-expired by `sweepExpiredShopifyInstallStates()` (`/api/cron/run`).

Migrations live in `drizzle/`, generated from the schema via `npm run db:generate` and applied via `npm run db:migrate`. Never hand-edit the database through Neon's SQL console — it creates drift between what the code believes exists and what's actually there.

## The gate contract

`src/lib/gate.ts` is the single path to a money action in the whole codebase. Its contract, upheld and verified in Layer 1, binding every later layer:

1. **Reservation is atomic.** Budget is reserved against a `spend_caps` row via a single conditional `UPDATE` whose `WHERE` clause re-checks the balance in the same statement as the increment — never read-then-write as two steps, which race under concurrent requests. Verified live: 20 genuinely concurrent requests against a cap sized for exactly 5 landed at exactly 5 allowed.
2. **A failed money action releases its reservation.** If Razorpay rejects a call after budget was reserved, the reservation is given back via `releaseBudget()`. A failed payment never consumes cap.
3. **Every call writes an audit entry — allow, deny, or escalate.** Denials are not swallowed; they're the rows that prove the bound is real.
4. **The gate owns execution**, not just the decision. `executeAndSettle()` is the single reserve → call Razorpay → commit-or-release path, shared by both a direct allow and a merchant-approved escalation, so no caller can reserve budget and forget to settle it.
5. **The risk layer can only downgrade, never approve past a deny.** `assessRisk()` runs strictly after every deterministic bound check has already passed — by call order in `attemptMoneyAction`, not by convention — so a model can add caution (escalate) but has no code path back to deny or allow-when-otherwise-denied.
6. **Fail closed.** Any unexpected error (DB unreachable, ambiguous state, a model call failing) denies and logs why. Never a silent allow.
7. **Idempotent by request.** A repeated request sharing an `idempotencyKey` with an in-flight or completed action replays that action's outcome rather than reserving budget twice — including under genuine concurrency, where the loser of the unique-index race releases its own reservation and replays the winner's row (see FAILURES.md for a real bug this surfaced in drizzle's error-wrapping).
8. **Credentials are per-merchant, resolved by the gate, and their absence is a deny.** `checkBounds` loads and decrypts the calling merchant's Razorpay credentials before any other check that would reserve budget; no credentials connected is a bound failure like any other (`boundApplied: "merchant_razorpay_connected"`), not a crash. `executeAndSettle` reloads credentials fresh rather than threading them through, so a rotation or disconnect between attempt and execution — which matters most for `resolveEscalation`, which can run long after the original attempt — is caught there too.
9. **When a request names a variant, the catalogue is the only source of price and stock (Layer 4-1, re-pointed at product_variants in Layer 5-1).** `MoneyActionRequest.variantId` is optional; when present, `checkBounds` resolves the variant, checks it belongs to the same merchant as the agent and is `active`, and denies on a mismatch between the caller's `amountPaise` and `variant.pricePaise * quantity` — a buyer naming its own price for a real variant is treated as a bug or a probe, not a request to honour. Stock is a bound exactly like `spend_caps.spentPaise`: decremented via a single conditional `UPDATE` (`reserveStock`) whose `WHERE` re-checks `stock >= quantity` in the same statement, and given back (`releaseStock`) everywhere budget is given back — a failed execution, a losing idempotency race, and an escalation's reject path all release both together.
10. **`executed` is not `captured` — a verified payment is a separate, explicit transition (Layer 4-2).** `executeAndSettle` only ever sets `status: "executed"` after creating a Razorpay order/link — an intent to collect, not proof money arrived. `confirmCapture(moneyActionId, razorpayPaymentId, verifiedBy)` is the only function that transitions `executed` → `captured` (or, for a `holdOnly` order, → `held`), and it only runs after independent verification: either the browser's post-Checkout HMAC signature (`/api/checkout/verify`, `verifiedBy: "checkout_signature"`) or the `payment.captured`/`order.paid` webhook (`verifiedBy: "webhook"`). Both paths converge on the same function and the transition is idempotent — whichever signal arrives first wins, the second is a no-op, not a double-write or an error.
11. **Capture and refund are money actions too, gated the same way (Layer 4-2/4-5).** `captureHeldPayment()` (release a held escrow payment) and `issueRefund()` (full or partial, on a `captured` or `held` payment) both call Razorpay through `razorpay.ts`'s `capturePayment`/`refundPayment`, write an audit entry on every outcome including a genuine Razorpay-side rejection, and — for a refund — release the corresponding budget and (on a full refund) stock back to the cap/product, mirroring exactly what a failed execution already released. Neither function reserves new budget: both settle a reservation already made when the original order was created and gated.
12. **A request can ask for a Payment Link instead of an order (Layer 4-3), without changing how it's bounded.** `MoneyActionRequest.paymentLink` (a description + reference id) makes `executeAndSettle` call `createPaymentLink()` instead of `createOrder()` — budget is still reserved through the exact same `checkBounds`/`reserveBudget` path first. `money_actions.razorpay_entity_id` stores the link id in this case; `GateResult.paymentLinkUrl`/`paymentLinkId` carry the payable URL back to the caller. Used exclusively by the recovery pipeline's money-moving strategies (see below) — Layer 4-2's storefront/agent checkout always uses the order path.
13. **A negotiated price is only ever a merchant-agreed, gate-resolved reference, never a caller assertion (Layer 8).** `MoneyActionRequest.negotiationId` names a negotiation; `negotiation.ts`'s `resolveNegotiation()` independently re-derives the amount from the negotiation's own `agreedUnitPricePaise * quantity` and `checkBounds` denies on any mismatch — identical in spirit to `resolveVariant`'s `product_price_match` and `resolveOfferForRequest`'s `offer_price_match`. `variantId`, `offerId`, and `negotiationId` are mutually exclusive on a single request — naming more than one is denied outright (`purchase_target_ambiguous`) rather than resolved by precedence. Stock reservation reuses the single-variant path (`reserveStock`/`releaseStock`), since a negotiated price covers one variant at a quantity, never a bundle. A successful redemption marks the negotiation `redeemed` so it can never be replayed by a second purchase attempt — checked on both `attemptMoneyAction`'s direct-allow path and `resolveEscalation`'s approve path, since a negotiated purchase can be escalated by the risk layer like any other.
14. **A genuine multi-item cart is resolved fresh from the live catalogue at attempt time, never trusted as a pre-computed total (Layer 9-close-out).** `MoneyActionRequest.cartConversationId` names a conversation; `cart.ts`'s `resolveCartForCheckout()` re-reads every `cart_items` line's price and stock from `product_variants` right then and re-sums the total from scratch — `checkBounds` denies on any mismatch between the caller's asserted `amountPaise` and that live sum (`cart_price_match`), the same discipline every other purchase target uses. Mutually exclusive with `variantId`/`offerId`/`negotiationId` on the same `purchase_target_ambiguous` check point 13 describes. Stock reservation reuses the exact all-or-nothing multi-item loop (`reserveOfferStock`/`releaseOfferStock`) an offer's bundle already uses — a cart is structurally identical, just buyer-authored and ad-hoc rather than merchant-authored and fixed. On a successful reservation, the cart's lines are frozen into a `cart_purchases`/`cart_purchase_items` snapshot (`cart.ts`'s `snapshotCartPurchase()`) before the `money_actions` row is written, since `cart_items` itself keeps changing after checkout and a settled money action needs a permanent record of exactly what it bought.

15. **The Runtime Guardian is a bound evaluated inline, not a passive observer (Layer 13-4).** `checkBounds` calls `guardian.ts`'s `evaluateAndTransition()` immediately after the agent-status check, before the spend cap is even loaded — a `suspended`/`revoked` Guardian state denies outright (`boundApplied: "guardian_state:<agentId>"`), with zero budget or stock ever reserved. The evaluation itself computes five deterministic SQL-percentile-baseline signals (velocity, denied ratio, retry-same-target, escalation rate, AI-spend rate) against each agent's own rolling history — no model judges "is this anomalous." A breach advances the agent one step (`normal → throttled → suspended`); only an explicit merchant re-arm (`rearmAgent()`) resets it — a Guardian that silently reset itself once volume calmed down would let exactly the pattern it caught keep happening on a duty cycle.
16. **A dry-run shares the real `checkBounds()` call, not a copy of its rules (Layer 13-5).** `MoneyActionRequest.dryRun: true` runs every deterministic check — capability (checked by the caller before invoking the gate), mandate verification, Guardian state, spend cap, stock, price match — and returns the would-be `allow`/`deny` immediately after `checkBounds` succeeds, before `reserveBudget` is ever called. Writes an audit entry (`event: "preflight_evaluated"`, `decision: "n/a"`) so a simulation is visible in the trail without ever being confused with a real money action. Exposed via `POST /api/agent/preflight` and the merchant-facing `/dashboard/preflight` simulator (`runPreflightSimulation()` in `dashboard/actions.ts`) — both call the identical `attemptMoneyAction` function a real purchase would.
17. **A reservation that is never resolved is swept and released, deterministically, on a real deadline (Layer 23-2).** `executeAndSettle`'s own `try`/`catch` already releases budget and stock when the call itself throws — but a process that dies outright between reserving (`status: "allowed"`) and that block ever running leaves nothing to catch anything. `reservationExpiresAt` (set from the database's own clock, `RESERVATION_TIMEOUT_MINUTES` out, cleared the instant the row resolves) is what `sweepAbandonedReservations()` sweeps against, via the same conditional-`UPDATE` claim pattern point 9's `reserveStock`/`reserveBudget` already use — so two overlapping sweeps release a stranded reservation exactly once, never twice. Registered as `reservations:sweep-abandoned` in `/api/cron/run`.
18. **Merchant-authored agent terms are ordinary bounds, composed after the spend-cap balance check (Layer 21-7).** `checkAgentTerms()` reads `merchant_agent_terms` (absence means the conservative reading of every field) and denies on: a `registrationSource: "self_registered"` agent with zero completed purchases when `unknownAgentsAllowed` is false, or one whose order exceeds `newAgentOrderCeilingPaise`; or ANY agent's order at or above `mandateRequiredAbovePaise` without `MoneyActionRequest.mandateVerified: true` (set by the caller — the purchase route, the MCP `purchase` tool — immediately after a successful `verifyPaymentMandate()`, never computed inside the gate itself). The self-registered scoping matters: a merchant-issued agent was already vetted by the merchant at creation and was never "unknown" — unscoping this check would deny every existing agent's first purchase (a real regression this layer's own tests caught before shipping, see FAILURES.md).
19. **Shadow Mode forces every request through the existing dry-run path, checked before a single other bound (Layer 24-8).** `attemptMoneyAction()` reads `merchant_shadow_mode` (a presence table — a row means on) for the calling agent's merchant, and if present, overwrites the incoming request with `{ ...request, dryRun: true, shadowModeForced: true }` before anything else runs — regardless of what `dryRun` value the caller actually passed. This reuses point 16's real `checkBounds` call unchanged; the only new thing is that a shadow-mode merchant can never reach it any other way. The audit event is `shadow_mode_evaluated` rather than `preflight_evaluated`, so a merchant's decision stream can tell "the merchant asked to simulate this one call" from "shadow mode is on and simulated every call," even though both share the identical `decision: "n/a"` non-execution guarantee.

Any later layer (§2 checkout, §4 negotiation, §5 upsell, §6 payouts, §8 recovery) that creates, captures, refunds, or pays out money **must** call `attemptMoneyAction()` (or, for capture/refund/link-confirmation, the corresponding gate function above). A money action that reaches `src/lib/razorpay.ts` without having passed through one of these is a bug.

## The recovery pipeline

`src/lib/recovery/*` (Layer 3). The contract this binds for every later layer: **recovery attempts pass through the same gate and the same spend caps as any other money action, and are bounded by deterministic policy in `policy.ts`, never by a model.**

**Two ways to run the sequence, additively (Layer 17).** `runRecoveryForFailure()` itself is unchanged and can still be called synchronously (`/dashboard/recovery`'s "Run recovery" button, `runRecoveryBatch()`). `createRecoverySequenceTask()` (`runtime/runner.ts`) wraps the identical function in a durable task instead — one call per drain tick, resumable across whatever real backoff window the policy computes, with the runtime translating the same `RecoveryOutcome` into a task's own status rather than re-deciding anything. Neither path is more authoritative; they call the same function and hit the same bounds.

1. **Failure intake is one writer.** `recordPaymentFailure()` in `intake.ts` is the only way a `payment_failures` row is created, used identically by `POST /api/webhooks/razorpay` (`source: "webhook"`) and the merchant-triggered `loadDemoFailureBatch()` (`source: "simulated"`). Nothing downstream branches on `source` — it exists for display only.
2. **Diagnosis is cached, not repeated.** `diagnoseFailure()` runs once per failure and writes its result to `payment_failures.diagnosis`; a later recovery pass reads the stored diagnosis rather than re-classifying. A deterministic decline-code lookup table is checked before any model call, and a model failure fails closed to `category: "unknown"`, `recoverable: false`.
3. **Every bound lives in `policy.ts`, and only there.** `shouldAttemptRecovery()` is the sole place attempt limits, backoff timing, the ROI governor, and the high-value-human-escalation threshold are enforced — pure functions, no I/O, no model. `chooseStrategy()` is an exhaustive switch over the closed `DeclineCategory` enum with a `never`-typed default, so a category added later without a policy branch fails the build rather than falling through silently.
4. **The sequencer orchestrates, it doesn't decide.** `runRecoveryForFailure()` in `sequencer.ts` calls `diagnose.ts` for facts and `policy.ts` for the decision, then only carries it out — same separation `gate.ts` keeps between `checkBounds` (decides) and `executeAndSettle` (carries out).
5. **A stop is a recorded outcome, not a silent return.** When the policy says stop, the sequencer writes a terminal `recovery_attempts` row and an audit entry naming the stopping rule — the same principle that makes gate denials real evidence rather than invisible early exits.
6. **Money-moving recovery goes through the real gate, bounded by a real cap.** `retry_same_instrument`/`alternate_instrument`/`payment_link_nudge` all call `attemptMoneyAction()` with `paymentLink` set, through a lazily-provisioned, hidden per-merchant `__recovery_pipeline` agent with its own spend cap (see DECISIONS.md). A gate denial here — cap exhausted, no Razorpay account connected — is recorded as a normal `failed` outcome, exactly like any other agent's denied purchase, not handled as a special case.
7. **A successfully-created Payment Link is `pending`, not `succeeded` (Layer 4-3).** A link is paid asynchronously — the customer completes it later, if at all — so there is genuinely nothing more to know at creation time. `runRecoveryForFailure` records the attempt as `outcome: "pending"` with the real `razorpayPaymentLinkId`/`paymentLinkUrl` stored on the row; `recoveredPaise` stays 0 until resolved. **`recoveredPaise` is only ever set by `confirmRecoveryLinkPaid()`**, called from the `payment_link.paid` webhook, from the verified paid amount — never optimistically from the link having been created. This closes the gap Layer 3 documented and left open: before Layer 4-3, no order created here could ever be verified as paid (no checkout existed); now a real, payable artifact exists and a real payment against it produces a real, non-zero recovered figure.
8. **Attribution sums from one place.** `getRecoveryStats()` reads exclusively from `recovery_attempts.recovered_paise`, never re-derives a total from `money_actions` — two sources of the same number is a bug waiting to surface on stage, not a cross-check.
9. **Generating a link is real, and — since Layer 11-4 — delivering it is too, when a contact is on file.** `recovery/sequencer.ts`'s `deliverRecoveryLink()` enqueues a real, deterministic email (via `notifications/enqueue.ts`) to the failure's `customerContactId`, the moment a payment link is created. No customer contact on file is a normal, common state — most webhook-sourced failures carry no email — and is recorded honestly on the attempt (`"No customer contact is on file..."`), never treated as an error. A merchant can also add a contact by hand on `/dashboard/recovery`. Only email is wired; SMS/WhatsApp are still not (see "What's deliberately not here yet"). The email body is entirely deterministic — no model ever produces a number or URL in outgoing customer mail — and never includes the internal diagnosis category or ROI arithmetic.

## The agent API

Headless, no UI, authenticated by `Authorization: Bearer <raw-key>` compared against `agents.api_key_hash`.

| Route | Purpose |
|---|---|
| `GET /api/agent/status` | Remaining budget, cap window, agent status |
| `POST /api/agent/purchase` | Buy a product by id, or an arbitrary amount+context — routes through the gate |
| `GET /api/agent/actions/[id]` | Check an outcome by money action id — a denied/escalated action includes a `why` section (Layer 7): the recorded reason, the bound in plain language, its determinism, and the exact arithmetic. Now also includes a `mandate` block (Layer 21-4, `mandates.ts`'s `getMandateProofForMoneyAction()`) — `{ present: false }` when the action wasn't taken under a mandate (the common case), or the mandate's real id/status/lines when it was. Scoped to the calling agent's own actions only, verified by id enumeration. |
| `GET /api/agent/products` | The agent's own merchant's active catalogue (Layer 4-4) — no price it wasn't told is ever binding |
| `POST /api/agent/register` | Self-serve provisional agent registration (Layer 21-8) — public, unauthenticated, hard rate-limited per IP and per merchant. Closed by default; see `merchant_agent_terms` and "The protocol surface and proof of agency" below. |

`POST /api/agent/purchase` (v2, Layer 4-4, re-pointed at variants in Layer 5-1): `{variantId, quantity?}` buys a real catalogue variant at its real price — `amountPaise`, if also given, becomes an assertion the gate checks and denies on mismatch (`gate.ts`'s `resolveVariant`), never the source of truth. The original v1 shape (`{amountPaise, context}`, no `variantId`) still works unchanged, for spends outside the catalogue. `holdOnly: true` requests the escrow flow (Layer 4-5).

Every input is zod-validated. A denial is a successful `200` response with the reason in the body, never a `4xx`/`5xx` — an agent needs to read *why*, and an error status can't distinguish "over budget" from "server broke." **The one exception, deliberately not a contradiction (Layer 21-3):** a request with no valid bearer key at all gets `402 Payment Required` with an x402-shaped challenge (auth scheme, where to get a key, a pointer to `/.well-known/agent-commerce.json`) — this is a refusal to even consider a money action, since no agent identity exists yet to evaluate a bound against, not a denial of one that was evaluated. Every response from a real, authenticated attempt also carries a `receipt` field (Layer 21-6) — a signed JWT proving the decision, verifiable against the merchant's own published public key; `undefined` only on a signing failure, which never blocks the real decision. `POST /api/agent/purchase` is rate-limited per agent id (Layer 4).

## The MCP server

`POST/GET/DELETE /api/mcp` (Layer 5-4) — the same product exposed over the Model Context Protocol, Streamable HTTP transport, so an agent that has never seen custom integration code for this merchant can still discover and transact. Authenticated by the same `Authorization: Bearer <raw-key>` scheme as `/api/agent/*` (`mcp-server.ts` reuses `agent-auth.ts`'s `authenticateAgent`), **not spec-compliant OAuth 2.1** — see DECISIONS.md for why and what that gives up. Stateless: `sessionIdGenerator: undefined`, and a fresh `McpServer` instance is built per request via `createMcpServerForAgent()`, scoped to that one already-authenticated agent — no server-side session state persists between requests or leaks between agents.

Eleven tools, every one merchant-scoped by the authenticated agent's own `merchantId`:

| Tool | Does |
|---|---|
| `list_products` | Paginated catalogue, filterable by category/availability/price range |
| `get_product` | One product by id, all variants/attributes/availability |
| `search_products` | Deterministic substring/word-overlap match over name/description/SKU/attributes — no LLM call, so it's fast, free, and reproducible |
| `check_availability` | SKU + quantity → can it be fulfilled right now, and how much stock exists |
| `get_merchant_policy` | The structured return/refund/shipping terms (Layer 5-3), honestly reporting "not published" rather than a fabricated default |
| `get_spend_status` | The calling agent's own remaining cap/window — discoverable before attempting a spend, not just enforced after |
| `get_offers` (Layer 6-3) | Checks for a margin-aware bundle upsell relevant to a SKU — genuinely may return none, which is a normal result, not an error |
| `get_reward_balance` (Layer 6-5) | The calling agent's own reward-coin balance with this merchant, if a rewards program is enabled |
| `redeem_reward_coins` (Layer 6-5) | Redeems coins as a real, gated money action, bounded by the real balance and the merchant's redemption ceiling |
| `negotiate` (Layer 8) | Opens or continues a price negotiation on one SKU — a single tool for both directions of the exchange, since an agent only ever needs "here's my counter, what's the result." Returns `opened`/`countered`/`agreed`/`refused`; the floor is never disclosed, only whether a given counter cleared it |
| `purchase` | Buys by SKU + quantity, by `offerId` (Layer 6-3) to redeem a bundle upsell, or by `negotiationId` (Layer 8) to redeem an agreed negotiated price — in every case calls `attemptMoneyAction()` unchanged, the same gate, same bound checks, same `money_actions` row and audit entry as any other purchase, regardless of transport |

Every tool result is a successful JSON payload — `{decision: "allow"|"deny"|"escalate", reason, ...}` for `purchase`, `{found: false, reason}` for a not-found lookup — never a protocol-level error, matching the REST agent API's "a denial is HTTP 200" contract: an agent needs to read *why* a call didn't go its way, and a protocol error can't distinguish a refusal from a broken server. Tool descriptions state units explicitly (prices are integer paise) and the bounds a caller is subject to, since the description is what the calling model reads when deciding whether to invoke a tool.

`src/app/api/mcp/route.test.ts` calls the real route handler directly with a constructed `NextRequest` (no server process needed, same pattern as `agent/purchase/route.test.ts`) — proving the MCP `initialize` handshake, cross-merchant isolation by id enumeration on `list_products`/`get_product` (not empty-list), `costPaise` never appearing in any tool output, a real `money_actions` row and audit entry from an MCP-initiated purchase, and clean denials (over spend cap, unknown SKU) rather than protocol errors. Verified additionally against a real MCP client-shaped request sequence (`initialize` → `tools/list` → `tools/call`) via `curl` against the running dev server: a real Razorpay test-mode order was created through `purchase`, confirmed by reading back the resulting `money_actions`/`audit_log` rows directly from the database.

## The offer engine

`src/lib/offer-engine.ts`/`bundles.ts`/`discount.ts`/`reward-coins.ts`/`reward-actions.ts` (Layer 6). The contract this binds for every later layer: **the deterministic filter runs before the model, always; the model ranks within a set it cannot expand; every value-issuing action passes `attemptMoneyAction()` the same as every value-collecting one.**

1. **A discounted amount is only ever a merchant-authored, gate-resolved reference, never a caller assertion.** `MoneyActionRequest.offerId` names an offer; `discount.ts`'s `resolveOffer()` independently re-derives the amount from the referenced `bundles` row and `checkBounds` denies on any mismatch — identical in spirit to `resolveVariant`'s `product_price_match` bound, which stays completely intact (verified by `gate.offers.test.ts`'s first test: a purchase asserting a discounted amount with no offer referenced is still denied).
2. **The margin floor is enforced in code, before the model ever sees a candidate.** `runOfferEngine()` computes `bundlePricePaise - summed real costPaise` per candidate bundle and removes anything at or below zero from the set handed to Groq — the model physically cannot choose an unprofitable upsell, because an unprofitable one was never in its input. Tests assert this against the filtered candidate set directly, not just the eventual outcome.
3. **A refusal is a first-class recorded outcome, not a silent early return.** Every `runOfferEngine()` call — offer or not — writes one `offer_decisions` row with the exact `eligibleCandidateCount`/`belowMarginFloorCount` that produced the result. A model failure degrades to no offer (a different fail-closed than the gate's own deny-by-default: the offer is additive, so its absence must never affect the underlying purchase).
4. **A bundle purchase reserves stock for every item atomically and all-or-nothing.** `reserveOfferStock()`/`releaseOfferStock()` loop the same per-item conditional-`UPDATE` pattern `reserveStock` already uses, rolling back every already-reserved item if any one loses the concurrency race — no bundle purchase can ever hold a partial reservation.
5. **Reward coins are a money action in both directions**, per CLAUDE.md's own definition. `gate.ts`'s `executeAndSettle` has a third settlement branch (alongside order-create and payment-link) that writes a `reward_coin_ledger` row instead of calling Razorpay, since neither issuance nor redemption has a Razorpay counterpart — but both still reserve budget through the identical spend-cap checks as any other action.
6. **A coin balance is always the live sum of the ledger, never a cached column** — same reasoning as `recoveredPaise` living on the recovery attempt rather than the failure. A redemption's atomicity against concurrent over-redemption is enforced by making the ledger `INSERT` itself conditional on that live sum, computed in the same SQL statement, rather than introducing a second mutable balance that could diverge from what it's supposed to summarize. (A first implementation used a naive read-then-compare and was caught by its own required concurrency test before shipping — see FAILURES.md.)
7. **Issuance is idempotent by the originating purchase's own `money_action` id.** `confirmCapture` has two independent success paths (the browser's checkout signature, the webhook) that can both trigger issuance for the same capture; the gate's own idempotency-key mechanism means the second call replays the first's outcome rather than double-crediting.

## The explainability layer

`src/lib/explainability.ts`/`explain-decision.ts` (Layer 7). The contract this binds for every later layer: **this layer reads decisions and never makes them; a generated explanation is never persisted and never authoritative; refusal and deferral are distinct and separately counted.**

1. **Five sources (four from Layer 7, plus negotiation refusals from Layer 8), one normalised shape, nothing new decided.** `getUnifiedDecisions()` reads `audit_log` (gate denials and risk escalations — two different sub-cases sharing one table), `offer_decisions` (non-offers only — an offer that was made belongs to the existing `/dashboard/offers` surface, not this one), `audit_log`'s recovery-stop events (`recovery_stopped`, `recovery_escalated_to_human`, `recovery_write_off`), and `negotiations` (`refused_floor`/`refused_turns_exhausted` rows only — an agreed or still-open negotiation is not a refusal). Every field on the resulting `UnifiedDecision` is either copied verbatim from a source row or derived by a pure, exhaustively-tested mapping (a bound-label lookup, a fixed-substring arithmetic extractor) — nothing here evaluates a bound, changes a decision's outcome, or writes anything.
2. **Refusal and deferral are distinct, and a deferral is never counted as a refusal.** `kind: "refusal" | "deferral"` — an escalation (`risk_escalation` or `recovery_escalated_to_human`) hands off to a human and is a deferral; everything else the system declines on its own is a refusal. `getDecisionStats()` counts them separately, and the dashboard's headline number is refusals, framed as evidence a bound is real, never combined with deferrals into one bigger-looking figure. See DECISIONS.md.
3. **Determinism is derived from the source's own recorded evidence, never guessed.** A gate deny and a `recovery_stopped`/`recovery_write_off` row are always `deterministic`. A `risk_escalation` is `model_influenced` unless its reason carries `risk.ts`'s own `deterministicFallback()` prefix ("Model unavailable. Deterministic fallback: ..."), in which case it's `deterministic` — the case explicitly called out as most likely to be got wrong, and covered by its own test in `explainability.test.ts`. An offer-engine refusal is `model_influenced` only when the recorded `noOfferReason` shows the model actually ran (declined, or was unavailable); an empty eligible set or an all-below-floor set never reached the model at all and is `deterministic`.
4. **`costPaise` still never leaks, and neither does a per-candidate margin.** An offer-engine refusal's `arithmetic` exposes only `eligibleCandidateCount`/`belowMarginFloorCount` — plain integers — never the margin figures that produced them, even though those figures are derived from real cost data internally. Covered by `cost-paise-never-leaks.test.ts`'s Layer 7 extension, not a second parallel test file.
5. **A generated explanation is never persisted and never primary.** `explainDecision()` is called fresh on every request, shown alongside the verbatim recorded `reason` (always primary, always visible), and discarded — never written into `audit_log`, `offer_decisions`, or anything else read back later. Its prompt hands every number as an isolated, explicitly-authoritative fact line, the same fix `chat.ts`'s Layer 5-7 paraphrasing bug required (FAILURES.md) — verified directly in tests that every number in a real generated explanation traces back to a supplied fact. See DECISIONS.md for the honest limit: this guards against invented numbers, not against a correct number attached to an incorrect claim.
6. **Every read is merchant-scoped, and the agent-facing read is additionally agent-scoped.** `getUnifiedDecisions`/`getDecisionStats`/`getDecisionById` take a `merchantId` and never leak across merchants, proven by id enumeration (`explainability.test.ts`, matching `isolation.test.ts`'s standard). `getDecisionForMoneyAction()` — the function behind `GET /api/agent/actions/[id]`'s new `why` field — additionally re-checks the money action belongs to the calling agent, not just the calling merchant, since a decision here can expose one buyer's purchase pattern to another.

## The negotiation layer

`src/lib/negotiation.ts` (Layer 8). The contract this binds for every later layer: **a model may argue, only code may agree; the floor is never in the model's input; every agreed price is re-derived at redemption.**

1. **Code decides whether a variant is negotiable, whether a counter clears the floor, and the exact concession price — never a model.** `openNegotiation()` denies outright if `floorPricePaise` is unset (a real absence, never a permissive default). `submitBuyerCounter()` compares the buyer's counter to `floorUnitPricePaise` with a plain integer comparison before any model call could run; at or above the floor it agrees immediately, no model consulted at all. `computeConcessionCeiling()` is pure arithmetic — the concession schedule converges to the floor by the final allowed turn, the same category as `recovery/policy.ts`'s backoff schedule.
2. **The model's only job is phrasing an already-decided number, and it is architecturally incapable of changing it.** When a counter falls below the floor, code computes the exact price the merchant's agent will offer this turn and only then asks the model for one sentence proposing that price. `submitBuyerCounter` reassigns `counterPricePaise` from the code-computed ceiling unconditionally after the model call returns — there is no code path by which the model's response, however adversarial, could move the number a buyer is offered. Verified directly: `negotiation.test.ts` and `cost-paise-never-leaks.test.ts`'s Layer 8 extension both drive a real negotiation through a full turn budget and assert the merchant's counter never falls below the floor.
3. **The model never sees the floor, the cost, or the margin.** The prompt receives only the catalogue price, the buyer's counter, the turn number/budget, and the already-decided price it must phrase. This is the mitigation for a real leak this layer is the first to face: a negotiation that refuses at a floor reveals *where* the floor is by binary search across repeated counters — capping counters at `MAX_BUYER_COUNTERS` (3) makes that impractical to exploit for useful precision, and sourcing the floor from a merchant-authored price rather than `costPaise` means a successful probe reveals only what the merchant chose to state, never their actual margin. See DECISIONS.md.
4. **A refusal is a first-class recorded outcome, not a silent early return.** A negotiation only ever fails one way: the buyer's counters run out (`MAX_BUYER_COUNTERS`) while still below the floor — `status: "refused_turns_exhausted"`. (A second, distinct "gave up below the floor with turns still remaining" status was considered and dropped before any row ever used it, since `submitBuyerCounter` always offers another counter round rather than refusing early — see DECISIONS.md.) The terminal row preserves the exact buyer counter and turn count, surfaced on `/dashboard/explain` as a `source: "negotiation"` refusal, always `kind: "refusal"`, always `determinism: "deterministic"` — exhausting a turn budget is arithmetic, never judgment.
5. **An agreed price is only ever a merchant-authored, gate-resolved reference, never a caller assertion.** `MoneyActionRequest.negotiationId` names a negotiation; `resolveNegotiation()` independently re-derives the amount from the negotiation's own `agreedUnitPricePaise * quantity` and `checkBounds` denies on any mismatch — identical in spirit to `resolveVariant`'s `product_price_match` and `resolveOfferForRequest`'s `offer_price_match`, and verified by the identical style of test: a purchase asserting a different amount, referencing another buyer's negotiation, or referencing an expired one is denied (`negotiation.test.ts`).
6. **A negotiation is the redeemable artifact — there is no separate "agreed price" table.** Once `status` reaches `agreed`, the `negotiations` row itself is what a purchase redeems, the same way an `offers` row already is once `accepted`. `markNegotiationRedeemed()` transitions it to `redeemed` on a genuine allow (on both `attemptMoneyAction`'s direct-allow path and `resolveEscalation`'s approve path, since a negotiated purchase can be escalated by the risk layer exactly like any other purchase), so a second purchase attempt against the same negotiation is denied rather than replayed.
7. **The transcript is real and reconstructable, independent of the audit log.** `negotiation_turns` records every exchange — who spoke, what price was on the table, the message — because `audit.ts`'s `logAuditEntry` never throws into a money path and a failed write is silently swallowed, making `audit_log` an unreliable home for a record that must be complete turn-by-turn. A merchant reads it end to end from `/dashboard/negotiations`.

## Merchant auth

Real email/password accounts, not a hardcoded demo merchant. `/signup` and `/login` are Server Actions (`src/app/signup/actions.ts`, `src/app/login/actions.ts`) that hash/verify via `src/lib/password.ts` and create a DB-backed session via `src/lib/auth.ts`'s `createSession()`, which sets an `httpOnly`, `sameSite=lax` cookie holding the session id (not an encoded claim). `src/proxy.ts` does an optimistic cookie-presence redirect for `/dashboard`, `/login`, `/signup`; the authoritative check is `getSessionMerchant()`/`requireSessionMerchant()` in each page and Server Action, which look up the session row and check `expiresAt`. Logging out (`logout` Server Action in `app/dashboard/actions.ts`) deletes the session row and clears the cookie.

Every dashboard read and mutation is scoped by the session's `merchantId` — there is no code path that resolves "the merchant" any other way. `dashboard-mutations.ts`'s `setSpendCap`/`revokeAgent`/`reactivateAgent`/`createAgent`/`rotateAgentKey` and `gate.ts`'s `resolveEscalation()` all verify the target row (agent, escalation) actually belongs to the calling merchant before acting, so one merchant cannot mutate another's data by guessing an id. `src/lib/isolation.test.ts` proves this by enumeration — attempting each mutation and read against a second merchant's real ids while authenticated as the first — rather than only checking that an empty list stays empty, which would still pass if every ownership check were deleted.

**OAuth (Layer 12).** `merchants.passwordHash` is nullable — an OAuth-only merchant has none and simply has no email/password form to use. `oauth_identities` links `(provider, providerAccountId)` to a `merchantId`, unique on that pair. `src/lib/oauth.ts` implements both Google and GitHub's authorization-code flow by hand (no auth library — see DECISIONS.md), and `resolveOrCreateMerchantForOAuth()` holds the actual sign-in/link/create decision separately from the route handlers so it's unit-tested (`oauth.test.ts`) without a real provider round-trip: reuse an already-linked identity; auto-link to an existing merchant only on a provider-**verified** email match; create a new passwordless merchant; or refuse if the target email is already taken by an unverified/mismatched identity. `src/app/api/auth/[provider]/{start,callback}/route.ts` carries a CSRF `state` nonce in a short-lived httpOnly cookie and fails closed to `/login?error=...` on any bad state, provider error, or network failure — the same posture the password path already has. Both providers are entirely optional (`GOOGLE_CLIENT_ID`/`SECRET`, `GITHUB_CLIENT_ID`/`SECRET` in `src/lib/env.ts`); a provider's button is hidden on `/login`/`/signup`, never rendered broken, when its pair isn't configured.

## The design system (Layer 9)

`src/app/globals.css` defines the token system every surface consumes: a dark-only palette (`--ink`/`--ink-raised`/`--ink-overlay`, three type-emphasis levels), one narrow accent reserved for "this is actionable," and — the palette's real spine — a decision triad (`--allow`/`--deny`/`--escalate`, each with a bright/wash/line variant) matching the schema's own closed `allow`/`deny`/`escalate` enum. A fluid `clamp()` type scale, named motion tokens (`--ease-out`/`--dur-fast`/`--dur`/`--dur-slow`), and rhythm tokens (`--gutter`/`--section-y`/`--shell`/`--sidebar-w`) round it out. Chosen deliberately shifted away from Razorpay's own navy/dodger-blue brand (never cloned — see DECISIONS.md) and away from the generic indigo/violet-on-dark palette common to AI-generated interfaces. Typography: Fraunces (`next/font/google`, self-hosted) for display/heading text, Geist Sans for UI body copy, Geist Mono with `tabular-nums` for every number — money, ids, SKUs, percentages, counts — via a `.num`/`font-mono` utility class. **No component anywhere in the product renders a money figure in a proportional font.**

`src/components/ui/` is the shared component vocabulary every page builds from — adding a one-off styled element to a single page rather than to this directory is the thing to avoid, since that is how the system rots:

- `DecisionBadge` — the one true allow/deny/escalate/n-a rendering, driven by the semantic tokens.
- `Stat`/`MoneyStat` — the large-number component the command view and every stats header is built from; `MoneyStat` always renders through `money.ts`'s `formatPaise` (via `format.ts`'s `formatPaiseGrouped`, comma-grouping added as a display-only wrapper, never a second conversion path).
- `Surface`/`PageHeader` — card variants and the shared page-title/description/actions header.
- `Button` — real hover/active/disabled states plus a pending state driven by `useFormStatus`, so every Server Action form gets loading feedback without hand-rolled state.
- `Field`/`Input`/`Select`, `EmptyState`, `DetailsToggle` (a plain `<details>`/`<summary>`, works without JS), `Table`/`Thead`/`Tr`/`Th`/`Td` (right-aligned tabular-figure numeric cells).
- `Reveal` — one page-wide `IntersectionObserver` flipping `[data-reveal]`/`[data-rise]` elements once as they scroll into view, adapted from `../payloadservice/src/components/Reveal/Reveal.tsx`. Under `prefers-reduced-motion`, every element is set visible immediately rather than left hidden because the observer never fires — the same contract every motion primitive in this codebase follows.
- `DecisionComposition` — an honest, hand-authored inline-SVG allow/deny/escalate snapshot bar (integer counts only, no `/100` anywhere near it). Deliberately **not** a time-series chart: the real seeded merchant's activity is too thin and dev-session-bursty to chart a trend without fabricating one, so no sparkline was built (plans/layer-9's own "if a chart cannot be made honest and useful, do not ship one").
- `ReadinessGauge` — an SVG arc rendering the real weighted-checklist integer from `agent-readiness.ts`.
- `AmbientField` — the landing hero's procedural canvas backdrop (see "The public storefront" below and DECISIONS.md for why it's code-generated rather than a video file).

**The no-mocks contract** (plans/layer-9-interface-and-close.md fact 9), binding on every functional/session-scoped surface: a pending or "in progress" state renders only while a real async operation — a Server Action, a `fetch`, a live model call — is actually in flight, never on a fixed timer or for decoration; every list, transcript, or activity feed renders real rows read at request time, never a fabricated placeholder to make an empty state "look alive." The one deliberate, labelled exception is the public landing page's illustrative refusal example (see below) — a real merchant's private audit data cannot be displayed on an unauthenticated public page, so that one example is explicitly marked "Illustrative" rather than either fabricated silently or leaked from a real tenant.

## The merchant dashboard

Server-rendered under `/dashboard`, behind a grouped sidebar (`sidebar-nav.tsx`) rather than the flat top-nav that preceded Layer 9 — **Money** (Overview, Recovery, Escrow), **Selling** (Products, Offers, Negotiations, Rewards), **Trust** (Decisions — the route stayed `/dashboard/explain`, only the nav label changed — and Readiness), **Setup** (Agents & caps, Policies, Settings). A real collapsible drawer under `md:`, an unmistakable active-item indicator, and a live pending-escalation count badge sourced from the real `getPendingEscalations()` count (absent, not zero, when there are none). Mutations are Next.js Server Actions in `app/dashboard/actions.ts`, thin wrappers around the testable logic in `dashboard-mutations.ts` and `gate.resolveEscalation()`. Every action re-derives the merchant from the session rather than trusting a client-supplied id.

`/dashboard` is the command view (Layer 9) — the answer to "what happened with my money, and what did the system refuse to do?" — not agent management, which moved to its own `/dashboard/agents` route (setup, not monitoring). Four headline `Stat`/`MoneyStat` cards (money moved — `dashboard.ts`'s `getMoneyMovedStats()`, real `SUM`/`COUNT` over captured `money_actions`, kept distinct from and never re-deriving the recovery pipeline's own `recoveredPaise`; money recovered; refusals, framed as evidence a bound is real; the deterministic-vs-model-influenced split from `explainability.ts`'s `getDecisionStats()`), a `DecisionComposition` snapshot (`dashboard.ts`'s `getDecisionCounts()`, real allow/deny/escalate counts grouped off `audit_log`), pending escalations promoted above the fold when any exist, and the decision stream (the former "audit trail," restyled but functionally unchanged) as the centrepiece.

Creating or rotating an agent (`/dashboard/agents`) generates a raw API key server-side and returns it exactly once — only its SHA-256 hash (`agent-auth.ts`'s `hashApiKey()`) is ever persisted. The create/rotate forms are the one part of the dashboard that needs client state (`useActionState`, in `agent-key-reveal.tsx`) so the freshly generated key can be displayed once and then genuinely forgotten — a page reload never shows it again. Rotating replaces the hash on the existing row rather than delete-and-recreate, so the agent's spend caps and audit history survive a leaked-key response.

`/dashboard/policies` (Layer 5-3) is the merchant's structured return/refund/shipping terms: a live "as an agent would read it" preview sentence (`policy-text.ts`'s `describeMerchantPolicy()`) above an edit form for every structured field. A merchant who has never saved a policy sees "not published" as the preview, never an invented default. This is the only UI path to a merchant_policies row — the fields are what L5-4's MCP server and L5-5's public manifest expose, not this page's generated sentence.

`/dashboard/readiness` (Layer 5-6) is the agent-readiness scorer's surface: a headline integer percentage, then every check as a pass/fail row with its weight and, when failed, a specific fix message deep-linking to where to fix it. A separate panel offers an LLM-drafted description suggestion (`suggest-description.tsx`) for each product with a thin/missing one — shown as text to copy into the product edit form, never auto-applied.

`/dashboard/settings` (Layer 2-2) lets a merchant connect, replace, or disconnect their own Razorpay test-mode credentials. Connecting validates the pair against Razorpay first (`validateCredentials()` — a cheap `orders.all` read, not `orders.create`, so validation never litters the merchant's account) and only writes encrypted columns once that succeeds, so a typo can't strand a merchant with broken credentials overwriting working ones. The page never redisplays a saved secret, only a masked key id tail.

The audit trail (`audit-trail.tsx`) is designed for the merchant reading it, not for a developer debugging it: each row is a colour-coded decision plus the `reason` sentence, since `reason` is already required to be a full explanation (see CLAUDE.md — "a sentence explaining WHY, not a status code"). Everything else — the raw `event` string, `bound_applied`, and the linked money action's type/status/Razorpay order id — sits behind a "Show details" toggle per row, present only when there's something to show. The Refresh button re-fetches through a Server Action (`refreshAuditTrail()`) rather than `router.refresh()`/a page reload, so refreshing the trail doesn't reset scroll position or any other in-progress dashboard state.

`/dashboard/recovery` (Layer 3, extended Layer 4-3) is the revenue recovery pipeline's surface: a headline recovered-rupees figure and a restraint count ("N attempts deliberately not made"), the failure queue with a `source: simulated` badge, a per-failure "Show attempts" toggle (same pattern as the audit trail's details toggle) revealing every attempt's strategy/outcome/reason sentence — including, for a `pending` money-moving attempt, the real, clickable Razorpay Payment Link URL a customer (or a tester) can actually pay — and "Load demo failure batch"/"Run recovery" actions.

`/dashboard/explain` (Layer 7) is the unified refusal/deferral surface: a headline refusal count (framed as evidence bounds are real, not a gap) plus a separate deferral count, a per-source breakdown, and the deterministic-vs-model-influenced split as its own explicit line. The list below is filterable by source and kind, each row showing the plain-language bound label, the verbatim recorded reason, and any exact arithmetic that produced it — same "merchant-legible by default, technical fields behind a details toggle" pattern the audit trail established. The details toggle also offers an on-demand "Explain this in plain language" button (`explainDecisionAction`, a Server Action, called per-row rather than eagerly for the whole page) that shows a generated explanation clearly labelled as such, never replacing the recorded reason above it, and an honest "unavailable" message if the model call fails rather than a blank or a crash.

`/dashboard/products` (Layer 4-1, restructured Layer 5-1, full multi-variant management added Layer 9-close-out) is the merchant's own catalogue: an add-product form (price, cost, and an optional SKU — auto-generated if left blank — entered in rupees, converted at the form boundary via `money.ts`) creates a product with one default variant in a single submission, a list of every product with an inline "Edit" details toggle (editing that same default variant's SKU/price/cost/stock) and an Archive/Reactivate button per row (archiving cascades to every variant), and a link to the merchant's own public storefront URL. `costPaise` is labelled internal-only in the form and never rendered on any buyer-facing surface. This is the only UI path to creating a product — before this task, `scripts/seed.ts` was the only way one ever existed, exactly the shell-access gap Layer 2-3 closed for agents.

A product with more than one variant (sizes, colours, ...) gets a per-variant row instead of the single-variant fast path: each shows its own price/stock/SKU/attributes and an independent Archive/Reactivate button and Edit form (`dashboard-mutations.ts`'s `updateVariant`/`archiveVariant`/`reactivateVariant`, all merchant-ownership-checked the same way `updateProduct` already was). An "Add a variant" form (`addVariant`) attaches a new SKU/price/cost/stock/attribute row to any existing product — the actual gap Layer 5 left open, closed here rather than left as a documented limitation. A product's variants are never deleted, only archived, so a past `money_actions` row referencing one keeps pointing at something valid; `getPublicCatalogue` already filters a product down to only its active variants, so archiving every variant on a product effectively (and correctly) removes it from the storefront without needing to also archive the parent product.

`/dashboard/products`'s **Import catalogue** panel (Layer 5-2, `import-catalogue.tsx`) is the bulk-onboarding path: upload a CSV or paste unstructured text, review an editable preview table (every parsed/extracted field, including price shown prominently in rupees), then confirm. The preview lives entirely in client component state between parse/extract and confirm — two separate Server Actions (`import-actions.ts`'s `parseCsvPreview`/`extractPastedTextPreview` vs. `confirmImport`) enforce that nothing reaches the database until the merchant's explicit confirm click, mirroring `chat.ts`'s model-proposes/code-writes split.

`/dashboard/escrow` (Layer 4-5) is the hold-and-capture demo's surface: a form to create a real demo hold against one of the merchant's own products (opens the real Razorpay Checkout, `payment_capture: false`), and a list of every hold — held, captured, refunded, or auto-refunded on expiry — with Release/Refund buttons on anything still held. Sweeps expired holds on every page load via `escrow.sweepExpiredHolds()`.

## The public storefront

`/store/[merchantId]` (Layer 4-2, extended Layer 5-5/5-7/Layer 9), no authentication — a real, human-payable front door. Lists the merchant's active products (`storefront-catalogue.ts`'s `getPublicCatalogue()`, never exposing `costPaise`), each card showing its SKU and attribute values alongside price/stock (Layer 5-7 — a human sees exactly the structured data an agent reads via MCP), with a real "Buy now" (`buy-button.tsx`) that opens Razorpay Checkout, the hosted JS widget — never a server-side card form, which would take on PCI/OTP scope this project doesn't need (see DECISIONS.md). The page header also shows the merchant's policy summary sentence (`policy-text.ts`'s `describeMerchantPolicy()`) and, via `generateMetadata()` (Layer 9 added `title: merchant?.name` so a browser tab/bookmark identifies the actual store, not a generic title), links the Layer 5-5 discovery manifest in the `<head>`. `getMerchantStorefrontInfo()` (`storefront-catalogue.ts`) validates the path segment is UUID-shaped before it ever reaches the database — see FAILURES.md for the raw-Postgres-error bug this closed. The flow: `POST /api/checkout/order` creates a real order through the gate (via the hidden `__storefront_checkout` agent — see `storefront.ts`), accepting an optional `variantId` (Layer 5-7) so a variant the buyer chat resolved is bought exactly, not the product's default; the browser opens Checkout with that order id and the merchant's public key id (Layer 9 recoloured the widget's own theme to the product's teal accent), and on success `POST /api/checkout/verify` checks the HMAC signature against the merchant's own key secret before calling `gate.confirmCapture()`. The `payment.captured`/`order.paid` webhook is the backstop if the browser's post-payment call never lands (tab closed, network drop mid-redirect) — both paths converge on the same idempotent `confirmCapture()`. `buy-button.tsx`'s busy states (`useTransition`) show a real spinner only while the actual order-creation/Checkout-open sequence is in flight — no decorative loading state.

The unauthenticated marketing surface (`/`, `/signup`, `/login`) is a deliberately different visual register from everything behind a session: `AmbientField` (`src/components/ui/ambient-field.tsx`) is a `"use client"` canvas component drawing five soft radial-gradient blobs in the decision-triad palette, drifting on independent sine/cosine phases via `requestAnimationFrame`, redrawn at devicePixelRatio for crisp edges, and skipped (frozen on one static frame) under `prefers-reduced-motion` — chosen over a licensed/stock video file specifically so the hero has no external asset dependency and no attribution question (see DECISIONS.md). The landing page's "refusal as the hero feature" section is the one deliberate, explicitly labelled exception to the no-mocks contract below: a public page has no authenticated merchant to scope real audit data to, so it shows a realistic denial matching `gate.ts`'s actual reason-string format, marked "Illustrative" in the UI copy itself rather than either fabricated silently or leaking a real tenant's data.

## The buyer chat

`/store/[merchantId]`'s chat widget (Layer 4-6, restructured Layer 5-7, restyled Layer 9, real multi-item cart added Layer 9-close-out) — the human front door's conversational surface, `src/lib/chat.ts` and `src/lib/cart.ts` underneath. The split CLAUDE.md rule 2 requires, made concrete:

- **The model proposes, never decides or computes.** `classifyIntent()` asks the model (via `completeStructured()`) to classify a customer message into a structured `{action, productName, quantity}` against the real catalogue given in the prompt — it never writes to the database. With multiple lines possibly already in the cart, the prompt hands the model every existing line by name so `productName` can disambiguate *which* line a `set_quantity`/`remove_from_cart`/`counter_offer` refers to, not just whether one exists.
- **Code resolves and applies, at variant granularity, across as many lines as the buyer wants.** `applyIntent()` resolves the model's `productName` against the real catalogue's variants (Layer 5-7's `resolveProductByName`) — exact SKU match, then exact name, then a word-overlap score against a display name that folds in each variant's distinguishing attributes (`describeVariant()`), so "the 250g ethiopia" resolves the 250g variant specifically, not just the product by name. `resolveCartLineTarget()` then maps that resolved variant onto one of the cart's existing `cart.ts` lines (by variant id, or the cart's only line if there's exactly one and no name was given — never guessed among several). Validates stock, then calls `cart.ts`'s `addCartItem`/`setCartItemQuantity`/`removeCartItem`, which write real `cart_items` rows — one per distinct variant, not a single overwritten slot. If the model names a product/variant that doesn't resolve, the cart is left unchanged.
- **The model never states a number it wasn't given.** The reply-generation prompt hands the model the code-computed cart — now every line, not just one — as an isolated `SYSTEM FACT` block, explicitly marked authoritative — see FAILURES.md for the bug this fixed (Groq's small model paraphrasing a fact embedded mid-paragraph into a wrong quantity; the actual `cart` field returned to the client was always correct, only the chat bubble's prose was briefly wrong).
- **Checkout is the same real flow, extended to buy the whole cart in one order.** The widget's "Buy now" for a multi-line cart passes `cart: true` (resolved server-side back to the calling session's `conversations` row) instead of a single `variantId` — `/api/checkout/order` routes this through `cart.ts`'s `resolveCartForCheckout()` and the gate's new `cartConversationId` path (see the gate contract's point 14), so a two-item cart becomes one real Razorpay order for the summed total, not two separate checkouts. The chat itself still never creates a Razorpay order or a `money_actions` row directly.

Rebuilt in Layer 9 as real alternating chat bubbles (buyer right-aligned, assistant left-aligned, both on the token palette); Layer 9-close-out extended the cart summary panel to list every line with its own subtotal plus a running total. The three-dot "thinking" indicator renders strictly while the widget's own `sending` state wraps the live `fetch("/api/chat", ...)` call — there is no fixed-duration or decorative version of it, per the no-mocks contract. Conversation state (`conversations`/`chat_messages`/`cart_items`) is keyed by a browser-generated `sessionToken`, not any account — the storefront has no buyer login (see DECISIONS.md for why this is DB-backed rather than client-only state). Negotiation and the upsell offer engine both stay per-variant (see `negotiation.ts`/`offer-engine.ts`) — with several lines in the cart, both surface against whichever line was most recently added, not "the whole cart at once," since neither concept generalises cleanly to a heterogeneous cart without inventing a new kind of bound this project doesn't need yet.

## The embeddable widget

`/api/embed/v1.js` + `/embed/[publishableKey]` + `/dashboard/embed` (Layer 10) — a second front door onto the exact same buyer surfaces `/store/[merchantId]` already exposes. A merchant pastes one `<script>` tag into their own site's HTML and gets the real chat, cart, negotiation, and checkout flow running there, on their own domain, under their own branding — no new money action, no new gate path, no new spend cap.

**The publishable key is origin binding and configuration, not authentication.** `POST /api/chat`, `/api/checkout/order`, `/api/checkout/verify`, `/api/checkout/decline-offer`, and `/api/checkout/redeem-coins` were already public and unauthenticated before this layer (the storefront has no buyer login) — anyone could already call them with a merchant's UUID. `src/lib/embed.ts`'s `pk_`-prefixed publishable key (deliberately shaped so it can never be confused with an agent's `sk_` secret key — `assertNotSecretKey()` rejects one wherever the other is expected) adds three things that are real and worth having: an origin allowlist a merchant's key only works from, a per-merchant kill switch independent of the storefront, and attribution in the audit trail. It is stored in plaintext (unlike `agents.api_key_hash`) precisely because it's printed verbatim into public HTML by design — hashing a value that's already public buys nothing, and plaintext is what lets the dashboard show it again after a reload.

**The widget authenticates as nobody — it shares the storefront's own hidden agent.** The embed never holds, sends, or sees an agent API key. Every purchase it makes goes through `storefront.ts`'s `getOrCreateStorefrontAgent()`, the exact same hidden `__storefront_checkout` agent and spend cap `/store/[merchantId]` already uses — a leaked publishable key gets an attacker at most what visiting the merchant's public storefront already gets them, bounded by a real cap either way.

**Origin enforcement is a bound like any other — deterministic code, denied by default, logged as evidence.** `src/lib/embed.ts`'s `isOriginAllowed()` is a pure function: an empty allowlist denies (not "allow everything" — fail closed applied to a non-money bound), a missing `Origin` header denies, everything else is exact string equality against a normalised allowlist (no wildcard support — see DECISIONS.md). `src/lib/embed-cors.ts`'s `resolveEmbedRequest()` is the single place every buyer route consults it; a request with no `X-Embed-Key` header is untouched (the compatibility guarantee that protects `/store/[merchantId]`), one that names an unknown key, a key belonging to a different merchant, or a disallowed origin is always a 400 with a readable reason and an `embed_origin_denied` audit entry (rate-limited by origin so a hostile page can't flood the log). The embed key travels as a request **header**, never a JSON body field — a real browser CORS preflight (`OPTIONS`) carries no body, only headers, so a body-only key would be invisible to the preflight and the whole cross-origin flow would silently fail. Every touched route's `OPTIONS` handler (`handleEmbedPreflight()`) runs the identical resolution logic the `POST` does, so a preflight can never allow what the real request would deny.

**The iframe is a cross-origin mount of the identical component, not a second implementation.** `/embed/[publishableKey]` renders `ChatWidget` (`src/app/store/[merchantId]/chat-widget.tsx`) with `variant="embedded"` — same React component, same design tokens, same Razorpay Checkout flow `/store/[merchantId]` uses in `variant="floating"` mode; only positioning and the open/close affordance differ. `/api/embed/v1.js` is a small, framework-free, ES5-safe loader script (served from a route handler, not `public/`, so it can be regenerated without a build step) that creates a launcher button plus a sandboxed `<iframe>` pointing back at this app's own origin — `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"` and `allow="payment"` are both required for Razorpay Checkout's UPI/netbanking/3DS popups and redirects to actually open (verified against a real test payment inside a real iframe, not inferred).

**`frame-ancestors` is the browser-enforced half of the allowlist; the origin check on every API call is the server-enforced half.** The iframe route can't reliably read `document.referrer` from inside itself in every browser, so it doesn't try — `src/proxy.ts` (Node.js runtime by default in this Next.js version, not Edge-only) computes a real `Content-Security-Policy: frame-ancestors <merchant's allowed origins>` header per request from a genuine DB lookup, failing closed to `frame-ancestors 'none'` on an unknown key or an empty allowlist rather than omitting the header. This stops the widget being framed on an unlisted site at all; it is not, and does not claim to be, a substitute for the origin check every API call independently re-runs.

**`src/lib/embed-events.ts`'s `postToHost()`/`isEmbedMessage()` is the postMessage protocol both sides speak** — `{source: "thirdman-embed", type, data}`, iframe → host only. Real events (`cart_updated`, `order_complete`, `negotiation_agreed`, `offer_shown`, `chat_opened`/`chat_closed`) are emitted only from state the server already returned; there is no synthetic or timed event anywhere (the no-mocks contract applied to an API surface, not just a UI). Money crosses the boundary as both `amountPaise` (integer) and a pre-formatted `amountDisplay` string (via `money.ts`'s `formatPaise`, the one conversion path) — never a float. `window.ThirdMan.on()` wraps every handler call in its own `try/catch`, so one throwing handler cannot break the widget or block the others. `cost-paise-never-leaks.test.ts` is extended to cover this: an enqueued webhook payload for a purchase of a cost-marker product never serialises `costPaise`, and neither does an `EmbedConfig`.

**Outbound webhooks are a durable queue, never a synchronous call from a money-moving path.** `src/lib/webhooks/{enqueue,deliver,runner,policy}.ts` — `enqueueWebhookEvent()`/`enqueueStockChangedEvent()` write a `webhook_deliveries` row (status `pending`) from `gate.ts`'s `confirmCapture` success paths (both `/api/checkout/verify` and the Razorpay webhook route's `handlePaymentCaptured`) and `issueRefund`'s success path, always inside a `try/catch` that never lets an enqueue failure affect the money action's own response — a merchant's server being slow or down must never break a buyer's payment confirmation. A partial unique index on `(webhook_id, event_type, money_action_id) WHERE money_action_id IS NOT NULL` makes this idempotent at the database level: `confirmCapture` has two independent success paths that can both fire for one capture, and this is what stops that from producing two deliveries (Postgres requires the arbiter's `WHERE` predicate to match the partial index exactly — see FAILURES.md).

`deliver.ts`'s `attemptDelivery()` signs the exact sent bytes with HMAC-SHA256 (`X-ThirdMan-Signature`/`X-ThirdMan-Timestamp`, same "sign the exact bytes, never re-serialise" discipline `webhook-verify.ts` already established for inbound Razorpay signatures), enforces a 10s timeout, and classifies the outcome via `policy.ts`'s pure `isRetryableOutcome()` — 5xx or a timeout retries, 4xx does not, mirroring `recovery/policy.ts`'s own split between what's worth retrying and what isn't. `nextDeliveryAttemptTime()` is a pure backoff schedule (1m, 5m, 30m, 2h, 6h, then `exhausted`) with the exact same "pure function of attempt number and now" shape `recovery/policy.ts`'s `nextAttemptTime` uses. Exhaustion is a recorded outcome with a real audit entry naming the stopping rule, not a silent stop — the same discipline the recovery pipeline's own stopping rules follow. `policy.ts`'s `validateWebhookUrl()` rejects private/loopback/link-local IPv4 and IPv6 ranges (including the cloud metadata endpoint) at both registration time and before every send — SSRF prevention for the first time this codebase POSTs to a URL a stranger typed into a form. `runner.ts`'s `drainDueDeliveries()` is trigger-agnostic — it has no scheduler of its own, and is called from `POST /api/cron/run`'s job list (the one scheduled entrypoint this stack has, built on this same branch), which itself needs a real external trigger (Vercel Cron or equivalent) in a live deployment. `retryDelivery()` is the merchant-facing manual retry, scoped to the owning merchant.

`/dashboard/embed` (L10-6, in the Setup nav group) is the merchant's install surface: the real snippet with a copy-pasteable `<script>` tag, an origin allowlist editor, an appearance form (display name/greeting/accent colour — validated as a real hex colour before it ever reaches a stylesheet/CSS custom property — /position/feature toggles) with a **live preview that is the real widget in a real iframe**, not a drawing of one, and a webhook registration + delivery log with a per-row "Show details" (HTTP status, error text, next attempt time) and a real Retry action. Rotating the embed key or a webhook's secret follows the same "shown once, or shown-and-re-displayable depending on whether it's actually secret" split `agent-key-reveal.tsx` established — the embed key can be re-displayed (it was never secret), a webhook's signing secret genuinely cannot.

## Notifications

`src/lib/contacts.ts` + `src/lib/notifications/{policy,provider,enqueue,send,expiry,merchant-alerts}.ts` (Layer 11) — the delivery spine that reaches an actual human, closing the largest documented gap in the product: before this, a real recovery Payment Link was generated and then nothing ever told the customer it existed.

**Customer contact is a first-class, consent-tracked row, never inferred.** `customer_contacts` (`src/lib/contacts.ts`) is the only place a customer's address is ever stored — unique per `(merchantId, channel, address)`, so a customer captured from two different flows (a checkout, then later a restock request) is one row, not two, with one unsubscribe token that keeps working for the life of the contact. `recordContact()` never resurrects an unsubscribed contact on a later call — re-consent is a deliberate act, never a side effect of buying again. `isContactable()` is the sole bound and is checked from exactly one place (the queue's own enqueue path), so there is never a second opinion about whether someone may be emailed. `/unsubscribe` is public, token-only (the unguessable token *is* the credential — requiring a login to stop email would be user-hostile), and gives the identical response for an unknown token so the endpoint can't be used to test which tokens are valid.

**A separate durable queue from Layer 10's `webhook_deliveries`, on purpose.** `notification_deliveries` (`notifications/enqueue.ts`/`send.ts`) mirrors that table's shape — a row exists before any provider call is attempted, so a crashed process is recoverable, not a silent drop — but is a genuinely different module because the risk is different: `webhook_deliveries` signs a payload and guards against SSRF (a merchant's server is the recipient); `notification_deliveries` enforces consent and an anti-spam frequency cap (a human's inbox is the recipient). `notifications/policy.ts` owns every bound, pure and unit-tested, same discipline `recovery/policy.ts` and `webhooks/policy.ts` already established: a slower 5m/30m/4h backoff than webhooks (hammering a provider on a soft bounce burns free-tier quota for nothing), `MAX_NOTIFICATIONS_PER_CONTACT_PER_DAY` as a deterministic per-contact cap — distinct from and orthogonal to `recovery/policy.ts`'s own per-*failure* attempt ceiling, which covers a different case (several unrelated failures for one person). Suppression (unsubscribed, or over the frequency cap) writes a real `status: "suppressed"` row with the reason named — never a silent drop, the same "a stop is a recorded outcome" discipline every other bound in this codebase follows. A duplicate enqueue for the same `(notificationType, relatedEntityId, contactId)` is a database-level no-op via a partial unique index, not a hope that two cron ticks never overlap (see FAILURES.md for the real bug this exact shape of index caused before its `WHERE` predicate was repeated in `onConflictDoNothing`).

**One provider, honestly degraded when unconfigured.** `notifications/provider.ts`'s `sendEmail()` calls Resend (free tier, no domain verification needed — see DECISIONS.md) when `RESEND_API_KEY` is set, and falls back to a real console-log provider otherwise. This is not a mock: the queue, the retry policy, suppression, and the audit trail all genuinely exercise either way — the only difference is whether a real inbox receives mail — and every delivery row records which provider actually served it so the UI never claims "delivered" for a console-only send.

**The recovery pipeline's last documented gap, closed.** `recovery/sequencer.ts`'s `deliverRecoveryLink()` runs the instant a recovery Payment Link is created — it enqueues a fully deterministic email (amount/link/merchant name interpolated by code; a model is never asked to produce a number or a URL in outgoing customer mail) to the failure's `customerContactId`. No contact on file is a normal, common outcome (most webhook-sourced failures carry no email) recorded honestly on the attempt, never treated as an error. See the recovery pipeline section above, point 9, updated to match.

**Out-of-stock in chat now offers a real path forward instead of a dead end.** `src/lib/restock.ts` + `chat.ts`'s extended `applyIntent`: a genuinely resolved, genuinely zero-stock variant (`variant.stock <= 0`, always deterministic) offers a restock alert — distinct from a product that doesn't resolve at all, which never gets offered one (conflating the two would tell a customer their typo is out of stock). The offer is tracked as real state on `conversations.pendingRestockVariantId`, not inferred from chat history. `scanForRestockedVariants()` is a periodic scan over real current stock, deliberately not a hook fired on every stock write — stock changes in several places (gate reservation/release, a merchant edit, catalogue import) and hooking all of them is how one gets missed; a scan over real state can only lag by at most one cron interval, never drift.

**One scheduled entrypoint for the whole stack.** `POST /api/cron/run` (`CRON_SECRET`, constant-time compared) drains every registered periodic job — `notifications:drain`, `escrow:sweep-expired` (now genuinely automatic across every merchant; previously only ran when a merchant happened to open `/dashboard/escrow`), `offers:sweep-expired`, `escalations:expire`, `restock:scan`, `merchant-digests:send`, and Layer 10's `webhooks:drain` if present (imported dynamically inside a `try/catch` so this route never fails to build without that module). Each job is isolated — one throwing never stops the rest — and every job is idempotent under overlapping ticks via the same partial-unique-index discipline the money-moving side of this codebase already relies on. See DECISIONS.md for why one shared endpoint over a bespoke trigger per feature.

**Escalation auto-expiry reuses the real rejection path, never a second one.** `gate.ts`'s `ESCALATION_EXPIRY_HOURS` (48h, mirroring `ESCROW_HOLD_EXPIRY_HOURS`) sets `escalations.expiresAt` at creation; `notifications/expiry.ts`'s `expirePendingEscalations()` calls `gate.ts`'s own `resolveEscalation(merchantId, id, "rejected")` on anything past it — the exact function that already releases reserved budget, stock, and offer/cart items atomically and writes the audit entry. Deliberately not a duplicate release path: a second implementation getting the release logic wrong would leak spend-cap budget permanently, the worst class of bug in this codebase. Fails closed — timing out denies, never auto-approves; silence from a merchant is not consent.

**Merchant alerts are a digest, never per-event mail.** `notifications/merchant-alerts.ts`'s `sendMerchantDigestIfDue()` sends at most once per merchant per day, only for alert types the merchant hasn't disabled (`merchant_alert_settings`, default on — a merchant who never opens the dashboard is exactly who this exists for), and only when there is genuinely something to report; an empty digest is worse than no digest at all, since it trains a merchant to stop reading them. `/dashboard/settings` carries the real toggle.

**Reward coins can now buy real AI usage, honestly labelled.** `src/lib/ai-credits.ts`'s `redeemAiCredit()` reuses the exact `reward_coin_ledger`/gate path every other coin redemption already goes through (`reward-actions.ts`) for the debit — balance checked, then debited via `attemptMoneyAction`, THEN the model is called. A model failure after the debit refunds the exact same coins via `gate.ts`'s `refundRewardCoins()` — deliberately **not** another call to `attemptMoneyAction`: that would run the refund through the live risk layer like any new discretionary spend, and it once did exactly that, escalating a refund and stranding the coins in a pending-approval state (see FAILURES.md). `refundRewardCoins()` is modelled on the existing `issueRefund()` pattern instead — an unconditional correction of money already taken, writing the ledger row and its own `money_actions` row directly, with no `checkBounds`/risk-assessment step, the same reasoning a real Razorpay refund already follows. `ai_credit_tiers` are real Groq models under their real names (verified live against Groq's own `/models` endpoint before being hardcoded — see DECISIONS.md), never another vendor's name over a Groq response; every redemption stores `providerServed`, checked by test against the tier's own claim. `llm.ts` gained an optional `groqModelOverride` field so a tier's real model actually gets called — every pre-existing call site omits it and is unaffected.

## Authorization, supervision, and proof (Layer 13)

See [plans/layer-13-authorization-supervision-proof.md](plans/layer-13-authorization-supervision-proof.md) and [OWASP_AGENTIC_TOP10.md](OWASP_AGENTIC_TOP10.md). This layer closes the gap between "an agent is authenticated and under its cap" and "a human actually authorized *this* purchase, the agent is behaving normally right now, and we can prove both." Nothing here replaces the gate's existing bound arithmetic — every check composes *before* `checkBounds()`'s existing checks, or is a new numbered point on the gate contract above (points 15-16).

**Property-based proof the gate's own claims hold, before anything new was built on top of it.** `src/lib/gate.properties.test.ts` states the gate's central invariants — `sum(reserved) ≤ capPaise` under any interleaving of reserve/release, a release always returns `spentPaise` to *exactly* its pre-reservation value, no sequence produces negative remaining balance or coin balance, the per-transaction ceiling is never exceeded — as machine-checked properties over thousands of generated random operation sequences (`fast-check`, dev dependency only), split into a pure in-memory model (2000 runs each, cheap) and a small number of the same sequences run against the real DB-backed gate (25 runs, to prove the pure model actually matches the implementation, not just an idealized version of it). All 8 tests passed clean — a real proof, not merely an absence of a bug found, per the plan's own "either a clean proof or a real bug, both are wins."

**Capability scoping — authentication is not authorization (Layer 13-2).** A closed `agent_capability` enum (`products:read`, `policy:read`, `offers:read`, `rewards:read`, `rewards:redeem`, `negotiation:create`, `purchase:create`) plus `agent_capabilities(agentId, capability)`, a queryable, database-constrained join table rather than a jsonb blob — see DECISIONS.md. Refunds and payouts are deliberately absent from the enum entirely, a stronger statement than granting-then-revoking: no capability grant could ever expose them to an agent. `agent-auth.ts`'s `requireCapability(agent, capability)` is called first, before any route or MCP tool logic runs — a denial writes an `agent_capability_denied` audit entry naming the missing scope and returns a real 403 (REST) or an honest tool-result refusal (MCP), never a silent no-op or a 500. Existing agents were backfilled at migration time (`drizzle/0023`) with the full set matching what they could already do — a merchant's working integration doesn't break on deploy. `/dashboard/agents` gained a per-agent capability checkbox form (`setAgentCapabilities()`, a full-replace, not incremental) inside the existing disclosure that already holds the cap-change form. **This absence still holds after Layer 22's returns desk**: an agent can *request* a return via the existing `purchase:create` capability (see "The returns desk" below), but that request's best possible outcome is escalation to the merchant — there is still no capability, granted or gated, that could let an agent's own action reach `issueRefund`. A requester and a holder of a refund capability are not the same thing, and this codebase never builds the latter.

**AP2 mandate verification — the headline (Layer 13-3).** A documented, honestly-scoped subset of Google's Agent Payments Protocol: the Checkout Mandate and Payment Mandate verification path, as ES256 (ECDSA P-256)-signed JWTs — not the full W3C Verifiable Credential / SD-JWT stack with selective disclosure (see DECISIONS.md for exactly what's in and out). ES256, never Ed25519: the AP2 spec forbids a deterministic signature scheme here, since it would let an attacker build a rainbow table mapping known `checkout_hash` values to signatures — a real, non-obvious constraint, documented directly in `mandates.ts`. Each merchant gets a lazily-generated ECDSA P-256 keypair (`getOrCreateMandateKeypair()`) — the private key AES-256-GCM encrypted at rest via the existing `crypto.ts` helper (same pattern as Razorpay credentials), the public key stored plaintext since any counterparty must be able to verify without a secret. `issueCheckoutMandate()` signs a JWT naming the cart lines, total, and expiry; `verifyPaymentMandate()` runs six deterministic, fail-closed steps in order — signature validity, not expired, `checkout_hash` matches the presented JWT (structurally: the lookup is *by* that hash, so a tampered JWT simply matches no row), cart total matches exactly in integer paise, and the mandate has not already been consumed (a conditional `UPDATE ... WHERE status = 'issued'` makes redemption atomic under concurrency, the identical pattern `reserveBudget`/`reserveStock` already use). Every verification attempt — pass or fail — writes a `mandate_verifications` row and an audit entry naming exactly which step failed; a verification error never crashes into a 500, it degrades to deny. Opt-in per agent (`agents.mandateRequired`, default `false`) so existing demo flows are unaffected — wired into both `/api/agent/purchase` and the MCP `purchase` tool (a new `issue_checkout_mandate` MCP tool lets an agent request one), running *before* `attemptMoneyAction` is ever called.

**The Runtime Guardian — supervision (Layer 13-4).** Is this agent behaving normally *right now*, computed entirely from tables this codebase already owns (`money_actions`, `audit_log`, `ai_credit_redemptions`) — no new telemetry source, no model consulted. `guardian.ts`'s `computeGuardianSignals()` calculates five signals via raw SQL `percentile_cont` baselines over each agent's own trailing 14-day history (transaction velocity, denied ratio, retry-against-the-same-target, escalation rate, AI-spend rate) — a percentile, not a mean+stddev, since one outlier destroys a mean-based threshold. `evaluateGuardianSignals()` is pure and returns the first breach found in a fixed, documented priority order. A breach advances the agent's state one step (`normal → throttled → suspended`; `suspended` requires an explicit merchant re-arm, never an automatic reset) via `evaluateAndTransition()`, which is a **bound**, not an observer: called inline inside `checkBounds()` on every money-action attempt (see gate contract point 15), so a suspended agent is denied before budget is ever reserved — also swept periodically via `guardian:sweep` in `/api/cron/run`, so a burst-then-quiet pattern is still caught. Every transition writes an append-only `guardian_transitions` row and an audit entry naming the exact signal, observed value, and baseline — "8 failed payments in 90 seconds against a baseline of 1.2," never merely "suspended" — plus a real merchant notification (`notificationType: "guardian_trip"`) through Layer 11's existing delivery queue, only on a genuine suspension, not every throttle step. `/dashboard/guardian` is the incident view: every currently throttled/suspended agent, its tripping signal and baseline, its transition history, and a one-click re-arm.

**Preflight/dry-run — the real decision path, non-executing (Layer 13-5).** `MoneyActionRequest.dryRun: true` is a field on the same `attemptMoneyAction()` every real purchase calls (see gate contract point 16) — it is not a second function that could drift from the real rules. `POST /api/agent/preflight` (an agent-facing simulation) and `/dashboard/preflight` (a merchant-facing one, `runPreflightSimulation()` in `dashboard/actions.ts`) both call it identically. `gate.preflight.test.ts` proves the equivalence directly: the same inputs that deny on a real attempt (over the per-transaction max, insufficient stock, a suspended Guardian state) produce the identical deny reason on a dry-run, and a dry-run never touches `spentPaise`, `stock`, or creates a `money_actions` row — only a `preflight_evaluated` audit entry with `decision: "n/a"`, so a simulation is visible in the trail but structurally cannot be confused with a real allow/deny/escalate.

## The AI Treasury and the economic loop (Layer 14)

See [plans/layer-14-ai-treasury.md](plans/layer-14-ai-treasury.md). Turns Layer 11-8's reward coins from cashback into an economic mechanism: a merchant-set slice of successful GMV funds a pool that pays for both the buyer's AI credits and the merchant's own AI operations. **This is a configurable product mechanism demonstrated with this project's own simulation numbers — not a claim about Razorpay's real fee structure.** Every treasury movement is a money action: it writes to the audit log and every rupee figure this layer produces traces back to a real query, even though the allocation *rate* is a merchant-set parameter.

**The pool and its allocation (L14-1).** `treasury.ts`'s `computeAllocationSplit()` is the layer's central deterministic claim: `contribution = floor(capturedPaise * allocationBasisPoints / 10000)`, then `buyerPaise`/`merchantPaise` are each floored independently and `reservePaise` absorbs the flooring remainder — so the three shares always sum to *exactly* the contribution, never a paise lost or invented. Property-tested at 2000 runs against every legal share configuration. `fundTreasuryFromCapture()` is wired at the exact two sites `issueRewardCoinsForCapture` already uses (`/api/checkout/verify`, the `payment.captured` webhook) — funded only on a genuine capture, never a hold or an authorization, mirroring escrow's own "money that hasn't settled funds nothing" discipline. Idempotent against the same checkout-signature-vs-webhook race every other capture-time side effect here guards against, via a real partial unique index (`treasury_ledger_capture_dedupe_idx` on `(bucket, moneyActionId)` where `reason = 'capture_allocation'`) and `onConflictDoNothing`, not merely an application-level pre-check.

**Margin-aware rewards via a shared reward-rule AST (L14-2/L14-3 — one mechanism).** `reward-rules.ts`'s zod-defined grammar (`conditions: [{field: "orderValuePaise"|"marginPercent"|"priorCaptureCount", operator, value}]`, `multiplierPermille`) is the thesis made literal: an LLM only ever *drafts* a candidate rule from a merchant's plain-English instruction (`draftRuleFromInstruction`); zod (`parseRuleAst`) either accepts or rejects it against this exact grammar — no field or operator outside the fixed list is reachable; deterministic code (`evaluateRuleAst`) is the only thing that ever evaluates a stored rule at issue time, against real order-value/margin/return-buyer facts computed fresh, never trusted from a caller. No `eval`, anywhere. A merchant-authored rule is approved at creation; an LLM-drafted rule is inert until the merchant reviews its compiled English description and explicitly approves — never activates unreviewed. Margin is computed from `productVariants.costPaise` only for a single-variant purchase; a cart/offer/negotiation purchase has no single honest margin figure, so margin conditions simply never match rather than being estimated.

**Model budgets and routing (L14-4).** Extends `llm.ts`'s existing `groqModelOverride` field rather than replacing the shared wrapper — `llm.ts` still owns provider selection, fallback, timeout, and logging which provider served a call; `model-router.ts` only decides *which model id* to request, from a real, sourced per-token pricing table (`model-pricing.ts`) and real token counts `llm.ts` now surfaces on every `CompletionResult`. `routeCompletion()` checks a use case's real remaining budget (`SUM(model_call_costs.costPaise)` since `periodStart`) *before* calling — an exhausted or unconfigured use case degrades deterministically to the cheapest known tier, never silently overspends. `getRoutingSavings()` reports real actual-vs-premium cost from recorded per-call rows, never an estimate.

**The Treasury dashboard (L14-5).** `/dashboard/treasury`: pool balance, the allocation policy form, reward rules (direct-entry and plain-English-draft-then-approve), per-use-case model budgets with real routing savings, and a real ledger table. Honest empty states before any capture has funded anything — no fabricated rows.

## Observability and the Command View (Layer 15)

See [plans/layer-15-observability-and-command-view.md](plans/layer-15-observability-and-command-view.md). Tracing and real-time streaming added on top of the existing gate and model calls, deliberately avoiding external dependencies (no Datadog/Sentry collector) in favour of in-memory stores and SSE.

**Tracing is scoped strictly to the money path (L15-1/L15-2).** `src/lib/tracing.ts` implements an OpenTelemetry `SpanProcessor` (`MoneyPathCaptureProcessor`) that intercepts span ends. If a span or its parent carries a `thirdman.money_action_id` attribute, it is kept; otherwise it is dropped instantly. This ensures only spans directly related to a money action are tracked in the 1000-span ring buffer (`CapturedSpanStore`), rather than flooding memory with UI render spans. Context propagation is wired manually via `CorrelationBox` to ensure async bounds cross correctly even if the moneyActionId is minted midway down the call stack. GenAI semantic conventions (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`) are recorded explicitly in `llm.ts` to surface token consumption and latency per decision.

**Live decisions via Server-Sent Events (L15-3).** `src/app/api/dashboard/decisions/stream/route.ts` implements a standard SSE endpoint utilizing Web Streams API (`ReadableStream`). It replaces manual dashboard polling with a live feed of `audit_log` rows. **Tenant isolation is structurally enforced:** the SSE route resolves `getSessionMerchant()` and hands exactly that merchant ID to `getAuditTrail()`, just like the manual refresh did. It degrades gracefully to polling if the connection drops.

**The Command View surfaces money at risk (L15-4).** The dashboard overview (`/dashboard`) was rewritten to show actionable money states: failed payments awaiting recovery, abandoned carts (derived from recent unresolved `cart_items`), and pending escalations. Every metric rendered is computed over real rows (e.g. `recovery_attempts`), never a mock or an estimated "GMV at risk" number.

## Model routing and armor (Layer 16)

See [plans/layer-16-model-router-and-armor.md](plans/layer-16-model-router-and-armor.md). Widens `llm.ts`'s provider set past Groq/Gemini, and adds a deterministic-first inspection layer around model calls. Both live in the same seam — `llm.ts` — because routing decides *where* a call goes and armor decides *whether it should happen at all*.

**Three more providers, one shared HTTP path (L16-1).** `LlmProvider` is now `"groq" | "gemini" | "nvidia" | "openrouter" | "zai"`. NVIDIA NIM, OpenRouter, and Z.ai all expose an OpenAI-compatible `/chat/completions` endpoint, so `llm.ts`'s `callOpenAiCompatible()` serves all three rather than three new SDKs — CLAUDE.md's "no new dependency without a clear reason" rule. A non-default provider is requested via `CompletionInput.provider` (set only by `model-router.ts`, never scattered across feature call sites) and always falls back to Groq on failure — `CompletionResult.provider` reports who actually served the call, never the one requested, generalizing DECISIONS.md's tier-honesty rule past Groq/Gemini to all five. `env.ts`'s `NVIDIA_API_KEY`/`NVIDIA_ENDPOINT`/`OPENROUTER_API_KEY`/`ZAI_API_KEY` are all optional — an unconfigured provider is simply unroutable, never a crash at import time.

**Real, sourced, and re-verified pricing (L16-2).** `model-pricing.ts`'s `MODEL_PRICING` gained NVIDIA `nemotron-3-nano-30b-a3b` ($0.05/$0.20 per 1M tokens) and `z-ai/glm-4.6` under both OpenRouter and direct Z.ai billing ($0.43/$1.75 per 1M tokens). A first choice for the NVIDIA row (`nemotron-nano-9b-v2`) was live when sourced but returned a real HTTP 410 "reached its end of life" days later — every model id in this layer was verified against the real `/chat/completions` endpoint before being committed, not just cited from a search result (see FAILURES.md). `providerForModel()` maps a known model id back to its provider, so `model-router.ts` can select model id and provider together rather than independently.

**Per-use-case provider preference (L16-3).** `model_budgets` gained a nullable `preferredProvider` column (migration `0026`) — one attribute of the existing per-merchant, per-use-case row, not a new table. `routeCompletion()` only honors a preference when the use case has real remaining budget; an exhausted or unconfigured use case always degrades to Groq's cheapest known tier regardless of preference, never to "the cheapest model on the preferred provider." `risk.ts` deliberately has no preference and stays on Groq — the only provider this project has real operating history for, and the one whose `deterministicFallback()` prefix `explainability.ts` depends on to label a decision `deterministic` rather than `model_influenced`; changing that would need re-verifying `explainability.test.ts`'s fallback-labelling contract, which this layer did not touch.

**Model Armor — deterministic-first, may only block (L16-4).** `model-armor.ts`'s `inspectInbound()`/`inspectOutbound()` are functions `llm.ts`'s callers invoke directly, not a service or middleware. The governing rule, stated in the module's own docstring: **armor may block, armor may never approve** — the same asymmetry gate contract point 5 already states for `risk.ts`. A deterministic pattern pass (instruction-override, role-override, prompt-exfiltration, and embedded-tool-call shapes inbound; email/card/phone shapes outbound) runs before any model is consulted; an optional model second-opinion (`allowModelEscalation`, off by default) may only escalate a clean deterministic verdict to suspicious, never clear a block, and a model failure there degrades to the deterministic verdict. Trust level governs failure mode, not verdict correctness: a scanner error fails closed on `untrusted` input and open (recorded, not blocking) on `internal` input — a real deterministic match still blocks regardless of trust level. Every non-clean verdict writes a `model_armor_blocked` audit entry naming the rule and a **scrubbed, bounded excerpt** — never the full text, and never an un-redacted number: `boundedExcerpt()` scrubs the excerpt against the same PII patterns `inspectOutbound` uses, then redacts any remaining run of 4+ digits outright, since a payload crafted to be logged is itself an attack (a real cost-marker leak through an unscrubbed excerpt was caught by `cost-paise-never-leaks.test.ts`'s own Layer 16 extension — see FAILURES.md). Wired into `chat.ts`'s `handleChatTurn()` at the untrusted-inbound point: a buyer message is scanned before `classifyIntent` ever calls a model, and a blocked message returns a plain refusal without writing to the conversation's model-facing prompt at all. **Armor never touches money** — no verdict here is ever read by `checkBounds()` or `attemptMoneyAction()`.

## The Agent Runtime (Layer 17)

See [plans/layer-17-agent-runtime.md](plans/layer-17-agent-runtime.md). Durable, resumable, long-running task execution as a Postgres-backed state machine advanced by `/api/cron/run`'s existing tick — there is no worker process on this stack, so a task's state has to survive between ticks as rows, not as anything held in memory. The contract this binds: **every money action a task takes still goes through `attemptMoneyAction()` under the task's own agent identity, bounded exactly as if the agent had made the call directly in a request** — the runtime schedules and resumes work, it never acquires authority to move money on its own.

**The task table and its state machine (L17-1).** `agent_tasks` (`src/lib/runtime/tasks.ts`): a closed `status` enum (`pending`, `waiting`, `claimed`, `succeeded`, `failed`, `cancelled`) — `waiting` (correctly blocked until `runAfter`) and `pending` (ready now) are deliberately distinct, so a stalled task and a patient one aren't conflated on the merchant-facing view. `agent_task_steps` is append-only, the task's own audit trail alongside (and independent of) `audit_log`. `claimDueTasks()` claims atomically: the eligibility check and the claim happen in one conditional `UPDATE` statement, the identical pattern `gate.ts`'s `reserveBudget`/`reserveStock` already prove correct for concurrent writers racing over the same rows — proven here too, by a real concurrent-claim test (10 parallel drains over 8 due tasks, every task claimed exactly once). Eligibility is genuinely two cases, not one: never claimed (pending/waiting, `runAfter` due), or claimed but the lease (`claimedUntil`) has expired — the crash-safety case, since a process that claims a task and dies mid-step must not strand it at `status: "claimed"` forever. Every timestamp comparison uses `sql\`now()\`` — the database's own clock — never the app server's `new Date()`, the same discipline `model_budgets.periodStart` already established (FAILURES.md); this project's own dev environment measured a real ~400-500ms clock skew against its Neon instance while building this layer, confirming the discipline matters in practice, not just in principle. A task kind that can take a money action (`recovery_sequence`, the only kind so far) is refused creation outright with no `agentId` — a structural guarantee, not a convention, that a task can never act with no bounded identity. Task-specific progress (`state`, jsonb) is validated by a zod schema per kind at every read/write boundary, the same discipline `reward_rules.ts`'s AST column already established for a jsonb column whose shape must stay closed.

**The runner (L17-2).** `src/lib/runtime/runner.ts`'s `drainDueTasks()` is trigger-agnostic, registered as `runtime:drain` in `/api/cron/run`'s job list exactly like `webhooks:drain` — no worker process of its own, isolated per task (one throwing never stops the drain), matching that route's own per-job isolation. Every bound (claim batch limit, retry ceiling, backoff, abandonment) is deterministic code; a step is a pure decision plus an effect, mirroring the separation `gate.ts` keeps between `checkBounds` and `executeAndSettle`. `recovery_sequence`'s step handler calls `runRecoveryForFailure()` completely unchanged and translates its real outcome into the task's own status: a stop from `recovery/policy.ts` (attempt ceiling, ROI governor, high-value escalation, unrecoverable diagnosis) is terminal and names the real stopping rule; a real gate denial reschedules the task onto the *same* `nextAttemptAt` the recovery policy's own backoff schedule already computed for the underlying `recoveryAttempts` row — read back, never re-implemented, so the runtime never carries a second, independent notion of "when should this retry."

**One real workload migrated, additively (L17-3).** `createRecoverySequenceTask()` resolves the same hidden `__recovery_pipeline` agent `runRecoveryForFailure` already acts as (`getOrCreateRecoveryAgent`, exported from `sequencer.ts` for exactly this) and uses it as the task's own `agentId` — the identity a task is created under and the identity that actually takes its money actions are the same real row, not two things that happen to agree today. Idempotent by `failureId`. The existing synchronous entry points (`runSingleRecoveryAction`, `runRecoveryBatch` on `/dashboard/recovery`) are completely unchanged; `/dashboard/recovery` now offers "Run in background" alongside the original "Run recovery" button, and both paths coexist rather than one replacing the other.

**The task view (L17-4).** `/dashboard/tasks`: every real task, its real attempt count against its real ceiling, its real next-run time when waiting, and its real step history (with a link through to the money action a step took, when one exists). Merchant controls — cancel a task, retry a failed one — are both real, audited actions (`agent_task_cancelled`, `agent_task_retried`), the same discipline a merchant re-arming a suspended Guardian-tripped agent already follows. Honest empty state before any task exists; no fabricated progress bar or estimated completion time.

## The Memory Bank (Layer 18)

See [plans/layer-18-memory-bank.md](plans/layer-18-memory-bank.md). Persistent, scoped context that outlives one chat session — real prior purchases, a real reward balance, past negotiation outcomes, and something a buyer explicitly said, retrieved on a later, genuinely separate session. The governing rule, checked structurally and behaviourally, not just stated: **memory is context, never a bound.** `gate.ts` has no import of `src/lib/memory/*` anywhere in its source, and `memory-never-influences-gate.test.ts` proves the stronger, behavioural claim directly — the identical purchase, same agent, same cap, is allowed or denied with byte-identical decision and reason whether or not that agent has a rich, deliberately adversarial memory bank planted for it.

**The schema and its scoping (L18-1).** `agent_memories` (migration `0028`): a closed `subjectType` enum (`customer_contact` | `agent` — the only two real, durable identities this product has; a session token is deliberately not one, and an anonymous storefront visitor genuinely gets no memory rather than being fingerprinted), a closed `kind` enum (`derived` | `stated`, no third), a `key`/`value` pair constrained to a closed application-level vocabulary (not a DB enum — derived and stated keys are disjoint sets), and required, non-nullable `sourceType`/`sourceId` — a memory with no provenance cannot be created. Unique on `(merchantId, subjectType, subjectId, key)`: update-in-place, not an append-only history — a correction replaces the value, it never sits alongside the old one (see DECISIONS.md). `conversations.customerContactId` (same migration): a nullable FK written exclusively by `chat.ts`'s `provide_contact` handling, the same "written only by code" discipline `pendingRestockVariantId` already established — this is what makes a `customer_contact` subject reachable through the chat surface at all, since `chat.ts` previously extracted an email only to hand it straight to `requestRestockAlert()` without persisting an identity.

**Derived memory (L18-2).** `src/lib/memory/derived.ts`'s `recomputeDerivedMemory()`: pure deterministic queries over tables this codebase already owns — prior captured purchase count/most recent purchase (joined through `cartPurchases`/`conversations` for a `customer_contact` subject, direct for an `agent` subject), reward coin balance, past negotiation outcome, an outstanding restock request. Every fact carries a real `sourceType`/`sourceId` pointing at the row it summarises. `costPaise`/margin are never read into this module at all — not filtered out after the fact, simply never selected, the same discipline `storefront-catalogue.ts` already applies to a `PublicProduct`. Recomputation deletes a stale fact whose underlying condition no longer holds (a refunded purchase, a spent-out balance) rather than leaving it to disagree with reality — proven directly by `derived.test.ts`.

**Stated memory (L18-3).** `src/lib/memory/stated.ts` — `reward-rules.ts`'s draft → zod-validate → confirm pipeline, applied to something a buyer said instead of a merchant's reward policy. `extractCandidateMemories()` (a real Groq call via `completeStructured`) proposes zero or more candidates from one chat turn — zero is the normal, common result, and a model failure degrades to `[]`, never a guess. `parseCandidateMemory()` is the validation boundary: a closed `STATED_MEMORY_KEYS` enum and a bounded-length string value, rejecting an unknown key or an oversized/malformed value outright, mirroring `parseRuleAst`'s own rejection-test shape including an explicit injection-payload case. `writeStatedMemory()` always inserts with `confirmedAt: null` — inert until a merchant explicitly confirms it on `/dashboard/memory` (`confirmStatedMemory()`, audited as `memory_confirmed`). Nothing auto-confirms; a correction to an already-confirmed value resets `confirmedAt` to null, re-entering review rather than silently staying "confirmed" against new content.

**Retrieval and the injection boundary (L18-4).** `src/lib/memory/retrieve.ts`'s `getMemoryFactsForSubject()` reads only confirmed, non-expired rows, ordered deterministically, hard-capped at 8. **Rendering is the layer's real security property**: `renderMemoryFactBlock()` and its internal `FACT_TEMPLATES` map render each memory through one fixed template per key — a stored value is never concatenated raw into a system prompt beyond the slot its template explicitly allows, and an unmapped/unknown key (a defence-in-depth backstop, should one ever reach this far) is dropped rather than rendered. Wired into `chat.ts` at the exact point its existing `cartFact` SYSTEM FACT is built: a `memoryFactBlock` is appended with an explicit precedence statement — the cart, catalogue, and prices are authoritative and final, memory is background that always loses on conflict. An anonymous session (`conversation.customerContactId === null`) gets an empty block, not a fingerprint-derived guess.

**Retention (L18-5).** `expiresAt` is real and enforced — `sweepExpiredMemories()` registered as `memory:sweep-expired` in `/api/cron/run`'s job list, the same one-line pattern every other sweep uses. `deleteMemory()`/`correctMemory()` are real, merchant-scoped, and audited (`memory_deleted`, `memory_corrected`). A buyer's own path to deletion is honestly limited to asking the merchant, who can act in one click — no buyer-facing self-serve flow, since that would need buyer accounts this product deliberately does not have (see DECISIONS.md).

**The memory view (L18-6).** `/dashboard/memory` (Trust nav group, badged with the pending-confirmation count): every real memory grouped by subject, its kind, value, confirmation state, and — where a real destination page exists (a `money_action` source links to `/dashboard/explain`) — a link to the row it came from. Confirm/correct/delete actions, following the shared `src/app/dashboard/actions.ts` pattern every recent layer uses. Honest empty state; no fabricated sample memory row.

**Tests, demos, docs (L18-7/8/9).** `memory-never-influences-gate.test.ts` (the layer's central proof, above), `isolation.test.ts` extended (a memory row created for merchant A is invisible to and untouchable by merchant B), `stated.test.ts`/`retrieve.test.ts`/`derived.test.ts` (validation rejection including an injection payload, unconfirmed-never-retrieved, retrieval bounds, expiry, deletion, derived accuracy, model-failure-degrades-to-no-memory), `chat-memory.test.ts` (a real, live end-to-end proof across two genuinely separate `handleChatTurn` sessions: a planted instruction-override attempt stays inert, a confirmed benign preference correctly follows the buyer into a new session), `cost-paise-never-leaks.test.ts` extended (a derived memory for a captured purchase of the cost-marker product never carries `costPaise`, raw or through the dashboard's rendered overview). `scripts/demo-failure-memory-injection.ts` and `scripts/demo-memory-does-not-move-the-gate.ts` — see the Scripts table below.

## The Adversarial Buyer and the Theatre (Layer 19)

See [plans/layer-19-adversarial-buyer.md](plans/layer-19-adversarial-buyer.md). The product's entire thesis — the buyer might not be a person — made visible: a real, autonomous, goal-driven AI buyer running against the live product from the outside, holding nothing but an API key, next to a live view of the merchant's real refusals. **The governing rule, checked structurally, not just stated:** the buyer agent is untrusted, external, and holds no privilege the product does not hand it over HTTP. `agent-buyer/isolation.test.ts` proves it directly — a static scan of every source file in `agent-buyer/` for an import of `@/lib/*` or a reference to `DATABASE_URL`, and a check that its `package.json` carries no `drizzle-orm`/`postgres`/`pg` dependency at all — the same "the demo is real because the two sides genuinely cannot see each other" property Layer 18's `memory-never-influences-gate.test.ts` proves for memory.

**The buyer agent package (L19-1/L19-2).** `agent-buyer/` — see the module map above for its files. Built on **Google ADK's actual TypeScript package, `@google/adk`** (not the plain `@google/genai` SDK, and not the unofficial `@iqai/adk` — `@google/adk` is Google's own, first-party, npm-published `google-wombot` package, `google/adk-js`), chosen after installing it and reading its real API surface rather than from memory (see DECISIONS.md). `LlmAgent` + `Runner`/`InMemorySessionService` drives a genuinely multi-turn loop: each agent turn is a real `Runner.runAsync()` call against a persistent session, continuing with a "keep working toward the goal" prompt until a turn produces no tool call at all (the model's own claim of completion) or a `bounds.ts` ceiling trips. `MCPToolset` connects to the product's real `POST /api/mcp` over Streamable HTTP with the same `Authorization: Bearer <key>` scheme every other agent integration uses — tools are discovered at runtime via the real MCP handshake, never hardcoded. Model: `gemini-3.5-flash`, pinned in `model.ts`, satisfying the Google hackathon's Gemini 3.5+ requirement; `THIRDMAN_MODEL_ID` can override it for local iteration once the free tier's real daily/per-minute quota is exhausted (see FAILURES.md) — Gemini 3.5+ either way, never silently a different-generation model.

**The loop's own deterministic ceilings (L19-2).** `bounds.ts`'s `checkCeilings()` — a hard step count, wall-clock timeout, per-tool-call timeout, and a purchase-attempt ceiling — is checked in `beforeToolCallback` before *every* tool call and short-circuits the call locally (never reaching the server) once tripped, returning a `{decision: "deny", reason}` shaped exactly like a real gate refusal so the model reads it the same way. None of this is asked of the model; it is this agent's own answer to "what stops a buyer with a bug from spending everything," applied to itself the same way `gate.ts` applies bounds to the product's side.

**Two real problems found and fixed by testing this against the live server (see FAILURES.md).** First: `MCPToolset` (and therefore `LlmAgent`) re-resolves `getTools()` — a full MCP `listTools()` handshake — on every single agent turn, not once per run; against a stateless MCP server (`sessionIdGenerator: undefined`) this multiplies real HTTP round trips per turn and, combined with each tool call's own connect/call/close cycle, tripped the merchant's own 60-req/min MCP rate limit (`agent-auth.ts`) purely from framework chattiness within a few negotiation turns — fixed by resolving the tool list once per run (`toolset.getTools()` called once, the resulting `BaseTool[]` handed to `LlmAgent` instead of the raw toolset) and adding a real inter-turn pause (`bounds.interTurnPauseMillis`) sized to Gemini's own real free-tier ceiling. Second: a Gemini rate-limit/quota failure surfaces as a normal ADK `Event` carrying `errorCode`/`errorMessage`, not a thrown exception — a `try`/`catch` around the loop alone silently saw "no tool call, no text" and would have reported a rate-limited turn as a clean, natural "succeeded" stop; fixed by checking `event.errorCode` explicitly inside the event loop and by making an empty turn (no tool call, no text, no error) a hard error in its own right rather than a fabricated success.

**The injection scenario's real free-text surface (L19-3).** The plan named "a negotiation message" as the honest candidate for the buyer-controlled free-text field an injection attempt travels through — but `negotiate`'s real MCP schema has no free-text buyer field (only a numeric `offerUnitPricePaise`), and Model Armor (`model-armor.ts`) was wired only into `chat.ts`'s human-facing storefront path, never into any agent-Bearer-authenticated route. The one field an agent genuinely controls that reaches a money action is `/api/agent/purchase`'s v1 `context` field (`amountPaise`+`context`, no `variantId`) — already real, already flowing into `money_actions`/the audit trail, just never armor-inspected. `inspectInbound()` is now called on that field (only on the `variantId`-absent branch — the `variantId` branch's `context` is server-generated, nothing to scan), inside the same `withMoneyPathSpan` trace as the capability check and mandate verification, denying before the gate ever runs on a flagged verdict. This completes Model Armor's coverage of a surface that already existed rather than inventing one — see DECISIONS.md.

**The scenario, and what it proves (L19-3).** `scripts/seed-buyer-agent.ts` provisions a real, persistent scenario — one agent (`purchase:create`/`negotiation:create`/`products:read`/`policy:read` only, `rewards:*`/`offers:read` deliberately withheld), a ₹2000 cap, a negotiable variant (₹900 list, ₹700 floor) tuned so 3 units at list price (₹2700) is genuinely refused and only a negotiated price makes the full goal reachable, and a second, out-of-stock variant. `scripts/reset-buyer-agent.ts` clears transactional state (open negotiations, `money_actions`, `spentPaise`) between runs without re-provisioning. A real, unscripted run against this scenario (`agent-buyer/src/run.ts`) is reproduced verbatim in FAILURES.md: the agent tried a naive 3-unit purchase (refused, `per_transaction_max`), opened and exhausted a negotiation (refused, turn-limit), reopened at a smaller quantity, reached agreement, and completed **two real purchases** — a negotiated price and a full-price unit — before a third attempt was correctly denied for exceeding the remaining cap. Real refusals from real, already-existing bounds; no new gate branch, no new denial reason, nothing added to `gate.ts`/`mcp-server.ts`/`agent-auth.ts` to make this scenario interesting.

**The Theatre view (L19-5).** `/dashboard/theatre` (Trust nav group, badged with the in-progress-run count). Two panels: the buyer's own run log (parsed read-side from an opaque blob, never structured at write time) on the left, the merchant's real decision stream (`getAuditTrail`, the same SSE `/api/dashboard/decisions/stream` `AuditTrail`/`audit-trail.tsx` already established) on the right. **Correlation is by real money action id, never by timestamp** — the buyer's own log carries whatever `moneyActionId` a `purchase`/`negotiate` tool result returned, and `dashboard.ts`'s `verifyMoneyActionIds()` independently confirms each claimed id against a real, merchant-scoped `money_actions` row before the view ever treats it as real; an unverified or cross-merchant id is shown as exactly that (`route.test.ts`'s ingest tests prove both a fabricated id and a real id belonging to a different merchant are correctly rejected), never silently paired. A run with no `run_ended` line yet renders as a real, distinct "in progress" state (`escalate` amber, matching `/dashboard/tasks`' own non-fabricated-progress discipline), not a spinner or a fake percentage.

**Getting the log there without database access (L19-5).** `buyer_agent_runs` (migration `0031`): `rawLog` stored as an opaque, untrusted blob — never parsed into a table anything else reads, never trusted as ground truth about a money action, the same discipline `agentMemories.value` documents for its own constrained-but-opaque content. `POST /api/agent/theatre/ingest` is an ordinary agent-Bearer-authenticated route (no special casing — the buyer agent authenticates as any other agent row would), bounded at 2MB, upserting by `(agentId, runId)` so a repeated upload replaces rather than duplicates. `agent-buyer/src/upload.ts` calls it once a run ends; a failed upload never changes the run's own local outcome, since the run already happened for its own sake.

**Tests, demo, docs (L19-6/7/8).** `agent-buyer/src/isolation.test.ts` (4, the layer's structural proof, above), `agent-buyer/src/bounds.test.ts` (8, pure — the step/purchase/timeout ceilings as code, no model call). `src/app/api/mcp/adversarial.test.ts` (1, real DB — a single sequence of hostile calls over the real MCP+REST route handlers: over per-transaction max, a price assertion that disagrees with the catalogue, a capability the agent was never granted, and the model-armor injection payload through `purchase`'s v1 context — every one refused with the reason the gate already had, `spend_caps.spentPaise` read back as unchanged after all four, then a real purchase within bounds still succeeds). `src/app/api/agent/theatre/ingest/route.test.ts` (6, real DB — 401 with no key, a size-ceiling 400, verbatim storage scoped to the calling agent's merchant, upsert-not-duplicate on a repeated `runId`, a fabricated money action id correctly unverified, a real money action id belonging to a *different* merchant correctly unverified). `scripts/demo-failure-buyer-overspends.ts` — deliberately distinct from `demo-failure-cap-exceeded.ts`: the call goes over a real, in-process MCP client/server pair (`@modelcontextprotocol/sdk`'s `InMemoryTransport`), the exact protocol shape `agent-buyer/`'s own MCP client uses, rather than a script calling `attemptMoneyAction()` directly — proving the bound holds for a caller shaped like a real autonomous agent's tool call. No live Gemini call (see FAILURES.md on the free tier's real quota, and `demo-failure-upsell-refused.ts`'s own precedent for the same reliability reasoning); the model's own live overspend-and-adapt behaviour is what the reproduced run in FAILURES.md demonstrates instead.

## Deployment and the agent-pressure surfaces (Layer 23)

See [plans/layer-23-deployment.md](plans/layer-23-deployment.md) and [DEPLOYMENT.md](DEPLOYMENT.md) (the actual runbook and commands — this section is the architecture, not the how-to).

**Deployment (L23-1).** Vercel hosts the app itself (the shortest honest path for a Next.js-on-Postgres stack already built around `@vercel/otel`), Neon stays the database unchanged. Google Cloud's real infrastructure proof is **Cloud Scheduler**, driving the existing authenticated `POST /api/cron/run` every minute — not a new mechanism, the same endpoint every prior layer's sweep already registers itself into, now with a real external trigger pointed at it for the first time. `vercel.json` deliberately carries no `crons` block: Vercel's own free-tier cron runs at most daily, which is genuinely insufficient once Layer 23-2's 5-minute reservation deadline exists, so building on it would have been the wrong mechanism dressed as the right one. **Cloud Run for the Layer 19 buyer agent is deferred, not skipped** — Layer 19 hadn't been built yet when this layer shipped, so there was no long-running agent process to containerize; DEPLOYMENT.md's closing section is the runbook for adding it once Layer 19 lands.

**Expiring stock reservations (L23-2).** The gap: `gate.ts`'s `executeAndSettle()` already releases a reservation on any error its own `try`/`catch` can see — but a process that dies outright (a serverless timeout, an OOM kill, a deploy restart) between reserving budget/stock (`status: "allowed"`) and that block ever running leaves nothing to catch anything. Ten agents hitting a catalogue at once, nine crashing mid-checkout, is exactly this: the stock and budget those nine reserved would otherwise stay locked forever, reachable by no other request. `money_actions.reservationExpiresAt` (migration `0029`, nullable) is set only at the moment of that reservation, to `now() + RESERVATION_TIMEOUT_MINUTES` (5, `gate.ts`) computed from the database's own clock (`sql\`now()\``, never the app server's — the same discipline `model_budgets.periodStart` and `claimDueTasks` already established, FAILURES.md) — and cleared back to `null` the instant `executeAndSettle` resolves the row to any terminal or handed-off state (`executed`, `failed`, or the reward-coin ledger's own `executed`), so a reservation that settles normally is never at risk of a later sweep touching it. `sweepAbandonedReservations()` claims anything still `"allowed"` past its deadline via the identical single-conditional-`UPDATE`-with-the-check-in-the-`WHERE` pattern `reserveBudget`/`reserveStock`/`claimDueTasks` already prove correct for concurrent writers racing the same row, then releases budget and stock (resolving `capId` the same way `issueRefund` already does — the most recent spend cap for the agent) and writes a `reservation_abandoned` audit entry naming `reservation_timeout` as the bound. Registered as `reservations:sweep-abandoned` in `/api/cron/run`'s job list. `/dashboard/reservations` (Money nav group, badged with the currently-held count) shows every reservation still open and exactly when it auto-releases — a merchant who cannot see locked stock cannot reason about it.

**Read pressure — shopping vs. buying (L23-3).** Not a new bound (the existing rate limiter already bounds request volume) — visibility into intent, which the limiter says nothing about. `agents.catalogueReadCount` (migration `0030`) is a running counter, incremented by `agent-auth.ts`'s `recordCatalogueRead()` on every real catalogue read that passes its capability check: the REST `GET /api/agent/products` route and the MCP `list_products`/`get_product`/`search_products`/`check_availability` tools. `guardian.ts`'s `computeReadPurchaseRatio()` divides that counter by a real count of the same agent's `money_actions` rows — pure arithmetic, no model judges whether an agent is "scraping." A `null` ratio (the agent has never purchased at all) is treated as the maximally lopsided case rather than hidden behind a divide-by-zero, since "500 reads, 0 purchases" is exactly the signal this function exists to catch. `lopsided` only trips past a 50-read floor (so a brand-new agent's first few browsing calls before its first purchase is never flagged) and only above a 50:1 threshold (deliberately high — a buyer genuinely comparing many variants before committing is normal shopping, not scraping). Surfaced, never blocking, on `/dashboard/guardian`'s "Shopping vs. buying" section (`getAgentReadPurchaseRatios()` in `dashboard.ts`, every active agent, sorted by read count) — a merchant acts on a lopsided ratio by revoking a key or tightening capabilities in `/dashboard/agents`; nothing here denies a request automatically, per the plan's explicit "surfacing is not blocking" constraint (an automatic block on this heuristic would deny real buyers who browse thoroughly, and that false-positive cost lands on real revenue). This is a running lifetime counter, not a rolling window — see "What's deliberately not here yet" for the honest limitation that implies.

**Tests, demos, docs (L23-4).** `gate.reservation-sweep.test.ts` (4, real DB: a stranded reservation is released and audited; an unexpired one is left untouched; two overlapping sweeps release exactly once — the idempotency property that matters most here; a real `attemptMoneyAction` purchase that completes normally is never picked up by the sweep). `guardian.test.ts` extended (4 new: a fresh agent is never flagged; a handful of reads below the floor is never flagged; many reads with zero purchases is flagged; a real sequence of gate purchases brings a lopsided ratio back down, proving the arithmetic reads real `money_actions` rows, not a mock). `scripts/demo-failure-reservation-abandoned.ts` — a reservation stranded by a dead process (simulated by backdating `reservationExpiresAt`, since demonstrating a real crash needs two processes) is found, released, and audited; run twice back to back, both clean, self-cleaning.

## The protocol surface and proof of agency (Layer 21)

See [plans/layer-21-protocol-surface.md](plans/layer-21-protocol-surface.md). Two related gaps closed: the discovery manifest disclaimed conformance to everything, including a real, documented AP2/x402 subset this product had already built; and `mandates.ts`'s proof-of-agency verification was built and invisible. **The governing rule: advertise only what is implemented, name the subset precisely, never claim conformance.** No change to `checkBounds`, `gate.ts`'s arithmetic, or any bound — this layer is discovery, documentation, and one new HTTP status code.

**Discovery, honestly multi-tenant (L21-1/L21-2).** `src/lib/discovery-manifest.ts`'s `buildMerchantManifest()` is the one body-builder behind both the existing per-merchant `/store/[merchantId]/manifest.json` (unchanged URL) and the new origin-root `/.well-known/agent-commerce.json` — one function so the two documents can never drift on what "this merchant's capabilities" means. The root document is a real **directory** of every connected merchant, each pointing at its own manifest, chosen deliberately over a query-param/subdomain "default merchant" resolution: a directory is truthful about a genuinely multi-tenant deployment in a way picking one merchant as "the" default would not be (see DECISIONS.md). The manifest now names, specifically: the MCP endpoint's URL/transport/auth (never duplicating the tool list, which would drift from `mcp-server.ts`'s own handshake); the closed `agent_capability` enum, with refunds/payouts' total absence from it surfaced as a fact an agent can read, not a policy claim; the merchant's own agent terms (L21-7) or an honest "unpublished" state; how to obtain access (self-registration if open, merchant-issued otherwise); payment rails (INR/Razorpay/test-or-live, stated plainly); and the documented AP2/x402 subset below, including the merchant's real ES256 public key (`exportSPKI`, via `mandates.ts`'s existing `getOrCreateMandateKeypair()` — never a second key).

**The x402 challenge shape (L21-3).** `POST /api/agent/purchase` with no valid bearer key now returns **HTTP 402 Payment Required** — a challenge naming the auth scheme, where to obtain a key, and a pointer to the discovery document — rather than a bare 401. This is deliberately NOT the same thing as a gate denial: a 402 means no agent identity exists yet to evaluate any bound against, while the existing "a denial is HTTP 200 with a reason" contract (load-bearing — an authenticated agent needs to distinguish "over budget" from "server broke") is completely untouched for every authenticated request, denied or not. The route's own comment states this distinction explicitly, since the two look similar at a glance.

**Proof of agency, surfaced (L21-4).** `money_actions.checkoutMandateId` (migration `0035`) is set directly by the caller (`/api/agent/purchase`, the MCP `purchase` tool) once `verifyPaymentMandate()` succeeds — the consumed mandate's own id threaded straight through to `attemptMoneyAction`, never re-derived by time-proximity. `mandates.ts`'s new `getMandateProofForMoneyAction()` reads it back for three surfaces: the agent-facing `GET /api/agent/actions/[id]`'s `why` block (the calling agent is the party that needs to fix an expired or tampered mandate); a "Proof of agency" disclosure on `/dashboard/agents`, batched per agent (`getMandateBackedPurchasesForAgent()`/`dashboard.ts`'s `getAgentsWithCaps()`) showing every mandate-backed purchase, with an explicit, honest empty state — since mandates are opt-in, "never presented one" is the common case and must never render as ambiguous or silently-verified. The mandate never becomes decorative: absence is always stated, never hidden.

**The Refusal Receipt (L21-6).** `src/lib/refusal-receipt.ts`'s `issueRefusalReceipt()` turns a completed gate decision — allow, deny, or escalate, all on the same terms — into a signed JWT, reusing `mandates.ts`'s existing keypair loading (no second signing path, ever). It asserts nothing the audit log doesn't already hold: it finds the exact `audit_log` row the decision just wrote (by `moneyActionId` when one exists, or by merchant + exact reason text for a pre-reservation denial) and signs a view over `{ decision, attempted, reason, boundApplied, determinism, moneyActionId }` — a read of recorded fact, never a second source of truth. A signing failure degrades to `receipt: undefined`, never breaking the real decision it rides alongside — issued as an additive field on the existing response body from `/api/agent/purchase` and the MCP `purchase` tool, so a caller that ignores it sees exactly what it saw before. `verifyRefusalReceipt()` is the counterparty-facing verification path; the real round-trip test (sign here, publish the key via L21-2's manifest, fetch it over HTTP, verify) is what actually proves the advertised key, the signing path, and the receipt are the same system, not merely a string comparison.

**Merchant-authored agent terms (L21-7).** The missing first-class concept behind "what does a merchant configure for AI buyers *as a class*," distinct from per-agent spend caps. `merchant_agent_terms` (migration `0034`, one row per merchant, absence meaning "unpublished," never a fabricated permissive default) holds only arithmetic-or-boolean fields, each enforced as an ordinary bound: `unknownAgentsAllowed`/`newAgentOrderCeilingPaise` (scoped to `registrationSource: "self_registered"` agents ONLY — a merchant-issued agent was already vetted by the merchant at creation and was never "unknown"; unscoping this would have denied every existing agent's first purchase, a real regression caught by the test suite before shipping, see FAILURES.md), `mandateRequiredAbovePaise` (unscoped — a value-based escalation applying to any agent, checked against a new `MoneyActionRequest.mandateVerified` boolean the caller sets after a successful `verifyPaymentMandate()`), `negotiationOpenToAgents` (gates whether `negotiation:create` may ever appear in a self-registered agent's default capability set — never revokes it from an agent granted it by hand), and the self-registration configuration below. All composed inside `gate.ts`'s new `checkAgentTerms()`, called from `checkBounds()` right after the spend-cap balance check — one more bound in the same list, not a parallel system. `setMerchantAgentTerms()` refuses outright to open self-registration without both a starting cap and a per-transaction max configured — a provisional agent with `purchase:create` and no cap is a gap this layer must never produce, not a merchant's choice to make. Surfaced as one page, `/dashboard/agent-terms` (Setup nav group).

**Self-serve agent registration (L21-8).** `src/lib/agent-registration.ts`'s `registerAgent()` closes the loop the manifest's "how to obtain access" section otherwise points nowhere: `POST /api/agent/register` (public, unauthenticated — the classic abuse surface for an endpoint that creates rows, so rate-limited hard, separately per IP and per merchant) issues a real `agents` row (`registrationSource: "self_registered"`, `registeredIp` retained for abuse investigation) plus a real `spend_caps` row and capability grants, using **only** the merchant's own configured numbers from `merchant_agent_terms` — never a hardcoded default this layer picks. Closed by default: no terms row, or `selfRegistrationOpen: false`, both refuse registration outright before anything is created. A provisional agent is not a new trust tier or a parallel code path — it is an ordinary `agents` row with small numbers, transacting through the identical gate, bounded by the identical `checkAgentTerms()` above once it starts making requests, building real transaction/refusal/Guardian history the merchant reviews before raising its cap by hand on `/dashboard/agents` (now showing a "Self-registered" badge).

**Tests, demo, docs (L21-9/L21-10).** `agent-terms.test.ts` (10, real DB/gate: unknown-agent gating scoped correctly to self-registered agents only, the new-agent order ceiling, mandate-required-above-value for any agent, and registration's closed-by-default/cap-composition/negotiation-gating behaviour). `isolation.test.ts` extended (2 new: self-registration scopes the new agent to the requested merchant only; a fabricated merchant id fails closed). `.well-known/agent-commerce.json/route.test.ts` (5: the directory resolves and filters to connected merchants only; every advertised `manifestUrl` actually resolves; the advertised MCP endpoint actually responds, never a 404; the advertised AP2 public key is a real SPKI PEM and ACP/UAP are honestly `implemented: false`; rate-limiting). `api/agent/register/route.test.ts` (5: validation, the 404 on a fabricated merchant, closed-by-default returns 200/`registered:false` not an error, a real issued key actually authenticates, rate-limiting). `refusal-receipt.test.ts` (2: the real sign-publish-fetch-verify round trip; verification fails against a different merchant's key). `cost-paise-never-leaks.test.ts` extended (2 new: a receipt's claims, the `.well-known` directory). `scripts/demo-failure-unverifiable-mandate.ts` — a Checkout Mandate genuinely signed by a *different* merchant's own ES256 key is refused at the merchant-scoped `checkout_hash` lookup, never reaching signature verification at all (a new script, not an extension of the existing tampered/expired demos — a wrong-key failure is structurally distinct from a wrong-amount or an expiry failure); run twice back to back, both clean.

## Hardening (Layer 26)

See [plans/layer-26-hardening.md](plans/layer-26-hardening.md). The governing rule: nothing here changes a money decision — `checkBounds`, the gate's arithmetic, and every audit reason are completely untouched by this layer. Everything here changes who can reach a money action, and how often.

**The distributed rate limiter (L26-1).** `src/lib/rate-limit.ts`'s in-memory `Map` — flagged as a known limitation since Layer 4 (see the now-resolved "What's deliberately not here yet" entries above) — is replaced by a Postgres-backed one. `rate_limit_windows` (migration `0032`) holds one row per `(limitKey, windowStart)`, quantized to `windowMs`-sized buckets aligned to the epoch rather than a rolling window per caller — this is what makes the increment a single atomic statement: every caller in the same bucket contends on the same row, and `INSERT ... ON CONFLICT (limitKey, windowStart) DO UPDATE ... WHERE count < maxRequests` either creates the row or increments it only if still under the limit, in one round trip. This is the identical conditional-write discipline `reserveBudget`/`reserveStock`/`claimDueTasks` already prove correct under real concurrency (gate contract point 1; Layer 17's task queue) — never a read-then-write. `checkRateLimit(key, maxRequests, windowMs)` is now `async` but otherwise signature-identical, so every existing call site (`/api/chat`, `/api/checkout/*`, `/api/agent/purchase`, the manifest, login) needed only an added `await`, not a rewrite. A query failure denies rather than allowing unlimited traffic through a broken guard (CLAUDE.md rule 4 applied to abuse protection). Stale windows are swept via `/api/cron/run`'s new `rate-limit:sweep-stale` job. Verified live under real concurrency: 20 simultaneous requests against a limit of 5 land at exactly 5 (`rate-limit.test.ts`), and `scripts/demo-failure-rate-limit-shared.ts` proves the counter is genuinely shared across what would previously have been two independent process instances. Postgres over Redis: see DECISIONS.md.

**Session hardening (L26-2).** Three real, small gaps in `src/lib/auth.ts`. **Rotation on login** — `createSession()` now deletes any session row named by a pre-existing session cookie before creating the new one, closing a session-fixation vector (an attacker who plants a session id before a victim authenticates would otherwise hold a valid session afterward). **Expired-session sweep** — `sweepExpiredSessions()`, registered as `sessions:sweep-expired` in `/api/cron/run`; expiry was already *enforced* on read (`getSessionMerchant`'s own `expiresAt` check), so this is table hygiene, not a closed security hole. **Rotation on password change** — `invalidateOtherSessions(merchantId, keepSessionId?)` deletes every session for a merchant except the one making the request; wired into a new `changePassword()` mutation (`dashboard-mutations.ts`) and a new "Change password" section on `/dashboard/settings`, so a merchant who suspects compromise and changes their password genuinely signs out every other session, not just cosmetically.

**Login throttling without a lockout (L26-3).** `src/lib/login-throttle.ts` — a real, deterministic, per-account exponential backoff (`login_throttle_state`, migration `0032`), deliberately not an account lockout: a lockout hands an attacker a denial-of-service tool against the merchant themselves (see DECISIONS.md). `FREE_ATTEMPTS` (3) cost nothing; past that, `requiredDelaySeconds()` — a pure function, unit-tested directly — doubles from a 2-second base, capped at 60 seconds, and decays back to nothing after 15 minutes of no further failures, so there is no input that produces a permanent lock. `AUTH_THROTTLE_EXEMPT_EMAILS` (`env.ts`, comma-separated, never a hardcoded address) is the one operational escape hatch, consulted only by `checkLoginThrottle` — the login route's separate IP-keyed `checkRateLimit` call does not honor it and was never meant to (see the finding below). **Constant-time regardless of account existence**: `login/actions.ts`'s `verifyLoginCredentials()` always runs a real `scrypt` comparison — against the account's real hash when one exists, against a fixed `DUMMY_HASH` otherwise — so a caller cannot distinguish "no such account" from "wrong password" by response timing; measured directly (not just asserted by inspection) in `login-timing.test.ts`. A burst of failures crossing the free-attempts threshold writes one `login_burst_flagged` audit entry (only when a real account exists — audit rows are merchant-scoped) and folds into `merchant-alerts.ts`'s existing once-a-day digest as a new counted item, never a per-attempt email.

A real bug this layer's own L26-6 security-review pass found and fixed before shipping: the pre-existing (Layer 2) `checkRateLimit(\`login:${email}\`, ...)` call was keyed by the attempted email, not IP — exactly the lockout-shaped DoS this layer's login-throttle.ts was explicitly designed to avoid, and not covered by `AUTH_THROTTLE_EXEMPT_EMAILS` at all (that allowlist only gates `login-throttle.ts`'s own check). An attacker who knew a merchant's email could hold that bucket saturated indefinitely, denying the merchant's own correct-password attempts. Fixed by re-keying it to client IP (via `next/headers`' `headers()` plus the existing `getClientIp`), leaving it as the burst-on-one-source guard it was always meant to be, distinct from `login-throttle.ts`'s account-keyed, distributed-attacker-shaped guard.

**Security headers (L26-4).** `next.config.ts` (new) adds the ordinary set that was simply absent everywhere outside the embed's own per-merchant CSP: `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, and `Referrer-Policy` globally; a real `Content-Security-Policy` on `/dashboard`, `/login`, `/signup`, and `/store` (self-scoped, `frame-ancestors 'none'` by default, `object-src 'none'`, allowing Razorpay Checkout's script/iframe/connect origins, `'unsafe-inline'` for script/style — a deliberate, documented compromise for Next's own hydration payload and Tailwind's inline styles, with no nonce-per-request wiring in this stack). Deliberately **no** static CSP rule matches `/embed/:path*` here — that route's `Content-Security-Policy` comes from exactly one place, `src/proxy.ts`'s existing per-merchant `frame-ancestors` computation (Layer 10-2), so the two policies can never fight by construction rather than by hoping Next's header-merge behavior favors the right one. Verified directly: `security-headers.test.ts` proves what `next.config.ts` actually ships (no route entry for `/embed`), and `embed-headers-compose.test.ts` proves `proxy.ts`'s own CSP is still exactly `frame-ancestors <allowlist>` per merchant, unaffected by this file's existence.

**Idempotency on public POSTs (L26-5).** The gate's own idempotency-key mechanism (gate contract point 7) already existed; the storefront checkout routes simply weren't passing a key through it. `BuyButton` (`store/[merchantId]/buy-button.tsx`) now generates one `crypto.randomUUID()` per checkout attempt, client-side, and sends it as `idempotencyKey`; `/api/checkout/order` threads it into every branch of `attemptMoneyAction` (single product, an accepted offer, an agreed negotiation, and cart checkout alike), `/api/checkout/hold-order` and `redeemRewardCoins`/`/api/checkout/redeem-coins` the same way. A retried request (a flaky mobile connection's own retry, a double-submit before the button's own `busy` state disables it) now replays the first attempt's real outcome — same `moneyActionId`, same `razorpayOrderId` — instead of reserving budget and creating a second Razorpay order; a genuinely new click generates a fresh key. `idempotencyKey` is optional everywhere it was added, so a direct API caller that omits it keeps the exact pre-existing, non-idempotent behavior. Verified against the real route handler and the real gate (no mocks): `checkout/order/route.test.ts` proves two requests sharing a key produce exactly one `money_actions` row and one stock decrement, two requests with different keys are genuinely independent purchases, and omitting the key entirely still works.

**Tests, demo, docs (L26-7/8/9).** See each task above for its own tests. `scripts/demo-failure-rate-limit-shared.ts` — the layer's required failure demo, the one gap deployment actively creates: two simulated "instances" alternate real `checkRateLimit` calls against one key, and the limit holds across both combined (not per-instance), backed by exactly one shared `rate_limit_windows` row. Self-cleaning, run twice back to back.

## Control surfaces (Layer 25)

See [plans/layer-25-control-surfaces.md](plans/layer-25-control-surfaces.md). Three tools for a merchant who is nervous about an agent, a cap, or the whole platform — none of which touches the gate's decision path, plus one that IS the merchant deciding. **The governing rule: everything here informs, nothing here decides, except the Kill Switch — which is the merchant themselves deciding, expressed through the identical Guardian bound `gate.ts` already enforces.**

**The Bound Simulator (L25-1).** `src/lib/bound-simulator.ts`'s `simulateBoundChange()` answers "what would a different cap have done to my real history" honestly: it **replays real recorded attempts, in the order they actually happened, never a forecast**. The per-transaction-max and remaining-balance arithmetic was extracted out of `gate.ts`'s `checkBounds` into a standalone, exported pure function, `checkCapArithmetic(amountPaise, cap)` — the simulator imports and calls this exact function rather than reimplementing the comparison, so the two can never quietly diverge (`bound-simulator.test.ts`'s own static check asserts the import). Real attempts are read from `audit_log`'s `money_action_attempt:*` rows (not `money_actions`, which only exists for attempts that passed `checkBounds` — a pure cap denial has no `money_actions` row at all), bounded to a window and `MAX_ATTEMPTS`. **Sequential consumption is the part most likely to be got wrong quietly**: the replay walks attempts oldest-first, tracking a running hypothetical `spentPaise` exactly as `reserveBudget`'s real running total does, so recovering an earlier denial genuinely changes what's available for every later attempt in the window — proven by a fixture where the naive per-attempt-independent answer differs from the correct sequential one (`bound-simulator.test.ts`). Only an attempt whose *original* denial was specifically a cap bound (`per_transaction_max:*`/`spend_cap_balance:*`) is ever counted as "recovered" — a guardian denial, an escalation, or a price mismatch would still have happened under any hypothetical cap, and is reported separately (`nonCapRefusalCount`) rather than folded in.

**The Kill Switch (L25-2).** `guardian.ts`'s `freezeAllAgents()`/`unfreezeAllAgents()` — a bulk, audited application of the identical bound `resolveGuardianBound` (inside `checkBounds`) already enforces for one agent at a time, never a new one. **Suspend, not revoke**: freezing moves every active agent's `agent_guardian_state.state` to `"suspended"` via the same `onConflictDoUpdate` shape `evaluateAndTransition` already uses — reversible, unlike `agents.status = "revoked"`, which is destructive and which a panicking merchant should not be able to apply to their entire integration with one click (see DECISIONS.md). **Atomic and complete**: both functions run inside one `db.transaction()`, so a freeze either suspends every active agent and records every snapshot, or (on any failure) none of it commits — never a partial freeze. `merchant_freezes` (migration `0036`) is a one-row-per-merchant existence table — present means frozen, absent means not, the same "absence is real" discipline `merchant_agent_terms` already established — and `agent_freeze_snapshots` (same migration) captures each active agent's Guardian state **at the moment of freezing**, so `unfreezeAllAgents()` restores exactly what was there rather than a blanket "back to normal": an agent already suspended by a real Guardian breach before the freeze stays suspended after it, never handed back a clean state it never earned. **Pending escalations are held, not resolved**: `notifications/expiry.ts`'s `expirePendingEscalations()` now checks `isFrozen(merchantId)` per escalation and skips it entirely while frozen — a freeze must never become an approval-or-denial path by way of a timer resolving something nobody looked at. Visible everywhere: `DashboardLayout` reads `getFreezeState()` once and renders `KillSwitchBanner` above the sidebar/content split on every route under `/dashboard`, not a banner on one page, with a one-click unfreeze right in the banner.

**The Trust Score (L25-3).** `src/lib/trust-score.ts`'s `computeTrustScore()` mirrors `agent-readiness.ts`'s exact shape: named, weighted components (`track_record` 40, `refusal_ratio` 25, `guardian_clean` 20, `negotiation_behaviour` 10, `account_age` 5) over real counts only — completed purchases, the real denied-attempt ratio (the same `audit_log` query shape `guardian.ts`'s own `deniedRow` uses), real `guardian_transitions` rows to `"suspended"`, real `negotiations` outcomes, and `agents.createdAt`. No model, no opaque weighting; every component ships its own human-readable `detail` string traceable to the real query behind it. `thinEvidence` (fewer than 3 completed purchases) is surfaced honestly rather than a confident-looking number produced from almost nothing, matching `agent-readiness.ts`'s own thin-evidence handling. **This is a read-layer figure and the test proving it is the task's real deliverable**: `trust-score-never-influences-gate.test.ts` proves it the same way Layer 18 proved memory's non-influence — a static check that `gate.ts` has no import of `src/lib/trust-score`, plus a behavioural equivalence test where an identical purchase, same agent, same cap, produces a byte-identical allow/deny decision and reason for an agent with a deliberately strong trust signal versus one with a deliberately weak one (a real Guardian suspension transition, a real failed negotiation).

**The decision permalink (L25-4).** `/why/[id]` — a route over `explainability.ts`'s already-existing `getDecisionById()`, adding no new fact, only a shareable URL. **Merchant-scoped by default**: a decision is not public data. The one way around the session scope is `src/lib/decision-share.ts`'s explicit, revocable, unguessable token (`decision_share_tokens`, migration `0036`) — minted per-decision by the owning merchant only (`createDecisionShareToken` re-verifies ownership via `getDecisionById` before minting), never "anyone with the id." `resolveShareToken()` is the *only* lookup a public request may use in place of a session, and it must resolve to *exactly* the `:id` in the URL — a valid token for a different decision never leaks this one. A miss (fabricated token, wrong decision) renders identically to a wrong id (`notFound()`), matching `isolation.test.ts`'s fail-closed standard elsewhere in this codebase (`decision-share.test.ts`). Since Layer 21's Refusal Receipt is built, the page offers `issueRefusalReceipt()` on demand for the merchant's own session only (never on a public share view) — the human-readable explanation and the machine-verifiable receipt for the same decision, side by side, per the plan.

**Tests, demo, docs (L25-5/6/7).** `trust-score-never-influences-gate.test.ts` (3, the layer's central proof, above). `bound-simulator.test.ts` (4: the static gate.ts-arithmetic-reuse check; the sequential-consumption fixture; non-cap refusals never counted as recovered; zero-history returns zero attempts). `kill-switch.test.ts` (5, real DB/gate: atomic freeze plus a genuinely denied real purchase attempt with `spentPaise` unchanged; double-freeze refused; unfreeze restores an already-suspended agent to suspended and a normal one to normal; a pending, already-expired escalation stays pending through a real `expirePendingEscalations()` sweep while frozen; unfreeze-when-not-frozen refused). `decision-share.test.ts` (5: a minted token resolves to exactly its own decision; a fabricated token resolves to nothing; minting for another merchant's decision is refused; revoking is merchant-scoped; listing tokens is merchant-scoped). `scripts/demo-failure-kill-switch-holds.ts` — an agent transacting normally, the switch thrown, the identical next purchase attempt denied by the real guardian bound with `spentPaise` unchanged, then unfrozen and transacting again; self-cleaning, run twice back to back, both clean.

## The returns desk (Layer 22)

See [plans/layer-22-returns-desk.md](plans/layer-22-returns-desk.md). There is a deliberate blank space in this product: `refund`/`payout` are absent from the `agent_capability` enum entirely, and this layer leaves that absence exactly as it found it. But a blank space isn't a solved problem — before this layer, a buyer who bought wrong had no path in at all. **The governing rule: the model decides whether a request is worth the merchant's attention. Code decides that only the merchant can approve it, and code computes every rupee.** Structural, not conventional: `src/lib/returns-desk.ts` (every model call in this layer lives here — the buyer conversation and the recommendation) has zero import of `gate.ts`, checked statically by `returns-desk.isolation.test.ts` the same way Layer 18 proved memory's non-influence on the gate and Layer 25 proved the Trust Score's. The only function that issues a refund, `src/lib/returns-desk-decision.ts`'s `approveReturnRequest()`, calls `gate.ts`'s existing `issueRefund()` unchanged and is reachable only from a merchant-actor Server Action.

**The eligibility gate, which runs first (L22-1/L22-2).** A new table, `return_requests` (migration `0037`) — deliberately not a reuse of `escalations`, since an escalation's `moneyActionId` always points at a still-pending action, while a return request points at an already-*captured* purchase and may never produce a money action at all. `returnRequestStatusEnum` keeps `declined_by_desk` (the model refusing to forward a claim) distinct from `rejected` (a merchant's own decision) — collapsing them would misattribute a decision to a human who never saw it, the same reasoning that keeps `negotiations.status` and the Agent Runtime's `pending`/`waiting` distinct. `checkReturnEligibility()` runs entirely in code, before a single model token is spent: the money action exists, belongs to this merchant and this requester (a `customer_contacts` id or an agent id — never a session token), is genuinely `captured`/`held`, is within any published `merchant_policies.returnWindowDays` (an *unpublished* window forwards to the merchant rather than inventing a default — the same "absence is real" discipline `merchant_policies` already established), hasn't already been refunded (in full — `money_actions.status = "failed"` — or in part, via a prior `return_requests` row), and has no other request already open (`return_requests_open_idx`, a partial unique index on `moneyActionId` scoped to `status = 'awaiting_merchant'`, the same pattern `restock_requests_waiting_idx` already uses). The refundable amount is computed here, by code, from the real money action, and stored on the request — the model never sees a chance to produce it. Any failure ends the request deterministically, with a real reason, before it ever reaches the merchant's queue.

**The conversation and the recommendation (L22-3/L22-4).** A return conversation is its own small state machine (`return_request_messages`) rather than a mode of `chat.ts`'s cart/session-scoped spine — a return references one already-completed purchase, not an open cart — but it reuses `chat.ts`'s two real disciplines: `model-armor.ts`'s `inspectInbound()` scans every buyer turn before it reaches a prompt (a return reason is free text, from a stranger, that a merchant will read and act on), and `completeStructured()`'s zod-validated output is a candidate, never a fact. **The model's one unilateral power points in the safe direction only**: `handleReturnDeskTurn()` lets it decline to forward a claim that stays incoherent after a real clarifying attempt, or one that plainly falls outside a published policy — ending the request as `declined_by_desk` with a real reason. It can never approve, never escalate an amount, and ambiguity always resolves toward the human (`ready_to_escalate`). `generateReturnRecommendation()` produces a summary/recommendation/reasoning triple, stored as generated text and labelled as such everywhere it renders; **a model failure degrades to escalating with no recommendation, never to declining and never to approving** — the merchant sees the raw conversation and decides without help, matching CLAUDE.md's "fail closed means the human still gets the decision, not that the buyer is refused because a model was down."

**The merchant's decision, and the refund (L22-5).** `/dashboard/returns` lists every open request with the deterministic facts, the buyer's own words in full, and the model's recommendation clearly marked as generated. Two Server Actions, `approveReturnRequestAction`/`rejectReturnRequestAction` (`app/dashboard/actions.ts`), both merchant-session-only and both delegating to `returns-desk-decision.ts` — approve validates the amount (positive integer paise, never exceeding the code-computed refundable amount) then calls `issueRefund()` unchanged; reject never touches `gate.ts` at all. Both outcomes are audited with the merchant as actor and notify the requester (a human buyer only — an agent has no notification channel and instead polls its own request id) via `notifications/enqueue.ts` with deterministic content, the same "a model never produces a number or a URL in outgoing mail" rule `deliverRecoveryLink` already follows. **Expiry**: `sweepExpiredReturnRequests()`, registered in `/api/cron/run` as `returns:expire-pending`, resolves a past-due request as `expired` — never `approved` — via the same conditional-`UPDATE ... WHERE status = 'awaiting_merchant'` claim pattern `sweepAbandonedReservations`/`expirePendingEscalations` already prove correct under an overlapping sweep. A pending return is folded into `notifications/merchant-alerts.ts`'s existing once-a-day digest (`returnPendingEnabled`) rather than a new per-event send.

**The AI buyer's path (L22-6).** `open_return_request`/`get_return_status`, both an MCP tool (`mcp-server.ts`) and a REST equivalent (`POST /api/agent/returns`, `GET /api/agent/returns/[requestId]`), gated by the existing `purchase:create` capability rather than a new one. **What makes this worth building rather than routine:** the tool's best possible outcome is *"escalated to the merchant, here is your request id"* — there is no capability that could raise that ceiling, because refunds aren't in the enum at all. Rate-limited per agent, the same shape `/api/agent/purchase` already uses. A human buyer's path is a public `POST /api/returns/open` — since this product has no buyer accounts (Layer 18's own limitation, applied here the same honest way), the one credential a storefront visitor can prove is the email already on file for that purchase's conversation (`chat.ts`'s `provide_contact` flow); a purchase whose conversation never captured an email has no reachable buyer identity, which is a real, honest limitation rather than a bug routed around with a weaker check.

**Tests, demos, docs (L22-7/L22-8).** `returns-desk.isolation.test.ts` (the structural proof above), `returns-desk.eligibility.test.ts` (every deterministic check, real DB — wrong merchant, wrong requester, uncaptured, outside window, no published window, already refunded in full and in part, duplicate open request), `returns-desk.recommendation.test.ts` (a real Groq call recommending approval still leaves the request `awaiting_merchant` with no refund issued; a genuine `completeStructured` failure against an impossible schema, proving the fail-toward-human path), `returns-desk.expiry.test.ts` (resolves as expired not approved, untouched before due, idempotent under two overlapping sweeps), `returns-desk.armor.test.ts` (a deterministic injection pattern blocked before any prompt), `returns-desk-decision.test.ts` (property-based amount-bounds coverage via `fast-check`, plus the merchant-decision wiring itself), `api/agent/returns/route.test.ts` (401 with no key, cross-agent id enumeration refused as 200/404 never a leak). `scripts/demo-failure-return-cannot-self-approve.ts` (the headline demo: a real model recommendation, whatever it says, leaves the refund unissued) and `scripts/demo-failure-return-outside-window.ts` (refused deterministically before any model call, the real policy clause named) — both self-cleaning, run twice back to back, both clean.

## The merchant CLI (Layer 20)

See [plans/layer-20-merchant-cli.md](plans/layer-20-merchant-cli.md). The onboarding gap this layer closes: everything after a merchant connects Razorpay and adds products is excellent; everything before it is a form, and the readiness score only ever scored the merchant's own data entry, never their actual store. This layer moves the audit to where the truth lives — the merchant's own codebase — via `cli/`, a standalone package published as `thirdman`. **It is also the one part of this submission a judge can run themselves, in their own repo, in sixty seconds.**

**The governing rule, enforced in code, not by convention: the tool reads freely and writes only what the merchant has seen and approved, file by file.** `fs-scope.ts`'s `ProjectScope.resolve()` throws on any path that would land outside the project root — every read (`readFile`, `listFiles`) and every write (`generate/diff.ts`'s `applyWrite`) goes through it, so "never outside the project root" is a property of the one chokepoint every operation shares, not a convention each check has to remember. `generate/diff.ts`'s `planWrite`/`applyWrite` split is what makes "shown as a diff, confirmed separately" real: nothing is ever written without first being planned (diffed against the real file on disk, or `/dev/null` for a new one) and shown to the merchant — there is no flag that skips this. `secrets.ts` is CLAUDE.md rule 5 enforced by the tool itself: `envLocalIsGitignored()` checks the project's *real* `.gitignore` (never assumes), and `writeAgentKeyToEnvLocal()` throws `UnsafeSecretWriteError` — refusing the write entirely — if it isn't covered, demonstrated live by `scripts/demo-failure-cli-refuses-unsafe-write.ts`.

**Stack detection (L20-2).** `stacks/detect.ts`'s `detectStack()` is evidence-based only — a small, explicit table of detectors, each reading real files (`package.json` dependencies, `next.config.*`, `wp-config.php`) and returning the exact evidence that matched, never a directory-name guess. Two or more real matches set `ambiguousWith` rather than picking one — `commands/init.ts` prompts the merchant to choose rather than silently guessing, since a wrong guess writes a file in the wrong place, "the worst failure mode this tool has" per the plan.

**The audit (L20-3), the heart of the layer.** `audit.ts`'s `runAudit()` composes four check modules — `checks/discoverability.ts` (a `/.well-known/agent-commerce.json`, `robots.txt` not blocking AI-agent user agents, a sitemap referencing products, `schema.org/Product` structured data), `checks/machine-readable.ts` (locatable product data, prices as real numbers rather than formatted currency strings — a parsing hazard and, in this project's own terms, a float waiting to happen — a stable SKU per variant), `checks/transactability.ts` (no CAPTCHA/OTP gate before checkout, a real API surface), `checks/integration.ts` (is the embed snippet already present, does a config exist) — each a real, deterministic read against the project's own files, weighted and summed exactly like `agent-readiness.ts`'s `ReadinessCheck`/score computation (`buildReport`/`computeScore` in `types.ts`), deliberately duplicated rather than shared since the two run against fundamentally different evidence (database rows vs. a filesystem) — see DECISIONS.md. **No model call happens inside the audit at all this session** — `summarize.ts`'s `summarizeFindings()` is the seam for the plan's "one legitimate model job" (turning findings into prose) and already implements the required degrade-to-no-prose behavior, but returns `null` unconditionally; a named, recorded gap (see DECISIONS.md), not a silent one.

**Generation and the diff (L20-5).** `generate/discovery-doc.ts` writes a static `.well-known/agent-commerce.json` — an honest, minimal subset of `discovery-manifest.ts`'s real shape (Layer 21), since the CLI has no database access and cannot report a real catalogue count; it points at the merchant's real live manifest once linked. `generate/config.ts` writes `thirdman.config.json` (merchant id, the embed's *publishable* key, the origin) — never a secret. `generate/snippet.ts` is the highest-risk write: it modifies a file the merchant wrote. **Idempotency is structural, not incidental** — every injected block is wrapped in `<!-- thirdman:embed:start -->`/`<!-- thirdman:embed:end -->` markers (or their JSX-comment equivalent for a `.tsx` layout), and `injectSnippet()`'s marker regex matches the bare marker text regardless of comment syntax, so a JSX-wrapped snippet from a prior Next.js run is still found and replaced in place on a second run rather than duplicated — proven directly by `snippet.test.ts`'s cross-comment-style idempotency test. `snippetTargetForStack()` is a small, explicit per-stack mapping (Next.js → `src/app/layout.tsx` before `</body>`, static HTML → `index.html`) rather than a sprawl of special cases; an unsupported stack gets the manual snippet printed instead of a guessed injection.

**Account linking (L20-6).** Built as a pasted one-time token rather than the plan's originally-described local-callback browser handoff — a real infrastructure tradeoff, confirmed with the user directly before building (see DECISIONS.md). A merchant generates a single-use, 10-minute token on `/dashboard/cli` (`cli-link.ts`'s `createCliLinkToken()`, the same opaque-token shape `decision-share.ts` already established) and pastes it into `init` when asked. `cli/src/link.ts`'s `redeemLinkToken()` posts it to `POST /api/cli/link`, which calls `cli-link.ts`'s `redeemCliLinkToken()` — deletes the token immediately (so a second use or a leaked copy fails closed, unlike `decision-share.ts`'s revocable-but-standing tokens, since this one grants a real mutation) and creates one new agent with exactly `products:read` + `purchase:create` — the plan's stated "minimum that permits reading and purchasing," never the full capability set — plus, if the merchant confirmed an origin, one addition to the embed allowlist. Both are audited (`agent_created`, `embed_origins_updated`) with the merchant as actor. The revealed key is shown once and written to `.env.local` only after `secrets.ts`'s gitignore check passes.

**`doctor` (L20-1).** `doctor.ts`'s `runDoctor()` re-runs the local integration-state checks plus two real network checks: does the discovery document actually resolve over HTTP, does a linked agent key still authenticate against `/api/agent/products`. Both degrade to a failed check with a clear reason on any network error — never a crash — matching CLAUDE.md rule 4's fail-closed spirit even though this is a read-only diagnostic, not a money path.

**Testability without a real TTY (L20-8).** The `prompts` package's real backend reads raw keypresses, which piped/CI input can't drive reliably — `prompter.ts`'s `Prompter` interface makes the interactive layer injectable, so `commands/init.ts` takes an optional `prompter`/`log` and every test in `commands/init.test.ts` exercises the *exact* production code path (detect → audit → confirm → write → re-audit) against a `scriptedPrompter`, never a separate test-only code path. 39 tests total, zero mocks, real fixture directories created under the OS temp dir per test (`test-fixture.ts`) and torn down after: `fs-scope.test.ts` (root-boundary enforcement, exclusion), `stacks/detect.test.ts` (7, evidence-based detection per stack plus the ambiguous/fallback cases), `audit.test.ts` (9, every check category against real fixture files), `generate/snippet.test.ts` (7, including the cross-comment-style idempotency proof), `secrets.test.ts` (7, including the real `.env.local` refusal), `commands/init.test.ts` (5, including the `--dry-run` byte-identical-afterward proof and the run-twice-no-duplicate proof). Server-side: `src/lib/cli-link.test.ts` (6, real DB) and `src/app/api/cli/link/route.test.ts` (4, real DB) cover the token's single-use/expiry/scoping behaviour and the route's validation.

**The failure demo (L20-9).** `scripts/demo-failure-cli-refuses-unsafe-write.ts` — a fresh temp project with a `.gitignore` that does not cover `.env.local`; `envLocalIsGitignored()` correctly reports `false`; `writeAgentKeyToEnvLocal()` throws `UnsafeSecretWriteError` with the real reason; `.env.local` is confirmed never created on disk. Self-cleaning, run twice back to back, both clean — imports directly from `cli/src` (via this repo's existing `tsx/cjs` script runner) rather than `src/lib`, the one demo script that exercises the standalone package rather than the main app.

**What's deliberately not built this session.** JSON-LD generation (`generate/json-ld.ts`) — the plan itself names this the first thing to cut if it can't be done cleanly, and a heuristic guessing at an arbitrary template's shape was judged not clean enough; the discoverability check still detects and reports missing structured data, it just doesn't try to write it. The model-summary prose step (`summarize.ts`). The full local-callback browser-handoff auth flow described in the plan (shipped as a pasted token instead — see above). Automatic code refactoring, support for every framework, a hosted CI service, and writing to git history are out of scope per the plan's own "Deliberately not built" section.

## Onboarding surfaces (Layer 24)

See [plans/layer-24-onboarding-surfaces.md](plans/layer-24-onboarding-surfaces.md). Layer 20 gave a merchant `npx thirdman init` — correct for a developer with a local repo, and unreachable by the merchants this product is actually for, who have a store admin panel and have never opened a terminal. This layer gives the same audit engine real front doors where those merchants already are, and adds a live Shopify integration and a conversational replacement for the per-agent setup form.

**The architectural claim, checked by test rather than asserted in prose: the checks live in one place, only the delivery differs.** `shared/store-readiness-checks.ts` sits deliberately outside both `src/` and `cli/src/` — a plain relative import from each side, no package boundary, no build step — so it's the single file both the Instant Audit (fed real fetched HTTP pages via `store-fetch.ts`) and the CLI's own audit engine (fed real files on disk) import for every judgment predicate: `robotsBlocksAgents()`, `hasProductStructuredData()`, `hasStableItemIdentifier()`, `checkoutRequiresHumanOnlyStep()`, `priceLooksLikeFormattedString()`, `sitemapReferencesProducts()`. "The two audits cannot silently diverge in their judgment" is therefore a property a test can check by import identity, not just by re-running both and comparing outputs. *Evidence-gathering* still differs by design (HTTP fetch vs. filesystem read — see DECISIONS.md's L20-3 entry on why `AuditCheck`/`ReadinessCheck` stayed separate shapes) — only the predicates are shared. The VS Code extension (`vscode-extension/src/diagnostics.ts`) imports `cli/src/types.ts` directly, never a forked copy of the CLI's own findings.

**The governing rule, and where it bites hardest this layer.** Every surface reads freely and writes only what the merchant has seen and approved. The Instant Audit fetches a bounded set of pages and produces a report, never a mutation — see `store-fetch.ts`'s fetching discipline below. The Shopify sync fetches a real catalogue from the Admin API and stops at a preview; nothing lands in `products`/`product_variants` until the merchant confirms, through the identical `importCatalogueRows()` write path `catalogue-import.ts`'s CSV and pasted-text sources already use — Shopify is a new *source*, never a new writer. The setup conversation drafts a fleet of agents and stops at a proposal. Shadow Mode evaluates real requests and stops before `executeAndSettle` ever runs, enforced inside the gate itself (gate contract point 19), not by a UI hiding a button.

**L24-1 — the Instant Audit.** `/audit`, public, unauthenticated, no signup or install. `store-fetch.ts`'s fetching discipline is not optional and is tested against a real local HTTP server: the target's own `robots.txt` is fetched and respected first, a real identifying user agent, a hard timeout/page-count/byte-count budget shared across the whole run via `AuditFetchBudget`, fetch-only with no form ever followed and no checkout ever touched, and every fetched page discarded the instant the report is produced — only the report is kept, never a crawler archive. `store-audit.ts`'s `runInstantAudit()` checks the homepage, `robots.txt`'s own content, the sitemap, and the `.well-known/agent-commerce.json` document Layer 21 already serves, scoring via `store-checks.ts`'s re-export of the shared predicates above, weighted the same way `agent-readiness.ts` already is. A page that could not be fetched (blocked, timed out, rendered entirely client-side) produces a check marked `notEvaluated` with a real, specific reason — never a fabricated low score standing in for "we couldn't check this." Reports are cached by URL for ten minutes (`instant_audit_cache`, swept by `sweepStaleInstantAuditCache()`), so a burst of repeat audits against the same store fetches it once.

**L24-2 — the VS Code extension.** `vscode-extension/`, a thin presentation layer over the CLI's own audit engine, never a fork of its judgment. `diagnostics.ts` turns a real `cli/src` `AuditCheck` finding into a Problems-panel diagnostic anchored to a real file position where the engine can produce one — "this price is stored as a formatted currency string" becomes a squiggle on the actual line rather than a paragraph in a terminal.

**L24-3 — the Shopify app.** `src/lib/shopify.ts` is a real OAuth2 install against a merchant's own shop. `beginShopifyInstall()` mints a single-use, ten-minute state row (`shopify_install_states` — a row rather than a cookie, since the redirect crosses into the merchant's own Shopify admin and back, a different browser context than the one that started the flow) and redirects to the shop's real `/admin/oauth/authorize`. `completeShopifyInstall()` redeems that state exactly once — deleted on read, same discipline as `cli_link_tokens` — exchanges the code for a real offline Admin API access token, and stores it AES-256-GCM encrypted via `crypto.ts`, the same treatment `merchants.razorpayKeySecretEncrypted` already gets. A shop already connected to a different merchant is refused outright (`shop_already_connected`) rather than silently reassigned; the unique index on `shopDomain` is the backstop, the readable refusal is in front of it. Only `read_products` is ever requested — this app reads a catalogue, it never writes back to Shopify or touches an order. `fetchShopifyCatalogue()` pulls a bounded page of real variants from the Admin API's REST product listing into the identical `ImportRowPreview` shape `catalogue-import.ts`'s other two sources already produce (HTML stripped from `body_html` for the description field, `MAX_IMPORT_ROWS` respected, `isTruncated` honestly reported for a merchant with more); `confirmShopifySync()` writes through `importCatalogueRows()` unchanged. Built and exercised as a **custom, unlisted app installed on a real Shopify development store** — real OAuth, real Admin API, real token exchange, no App Store review taken or claimed (see DECISIONS.md's scoping-honesty entry, the same posture Layer 20's CLI submission note already established).

**L24-4 through L24-6 — WooCommerce, copy-paste, the unrecognised-platform spec.** `woocommerce-plugin.ts` generates one complete, pre-configured `.php` file per merchant — merchant id and *publishable* key baked in, so the merchant never types a key, the single most error-prone step in every other integration flow, removed. The plugin proxies the real live discovery manifest through WordPress's own `template_redirect` hook (never a static copy that could go stale), injects the widget via `wp_footer`, and adds `schema.org/Product` JSON-LD read from WooCommerce's own product object at render time — real price, real SKU, real stock status, never a placeholder. Idempotent on re-activation (a single option flag), removes cleanly on deactivation (flushes the one rewrite rule it added). `integration-artifacts.ts`'s `artifactsForReport()` turns a failed Instant Audit check into the exact block to paste and exactly where — the literal content and placement, never a description of what to do — falling out of Layer 20's own generator logic rather than a second implementation. `unsupported-platform-spec.ts` produces a precise specification for a human developer to implement and review when no dedicated integration applies, framed explicitly as a spec for a person — the one thing this layer's own "what this layer must not do" section forbids is a paste-a-prompt flow whose result nobody reviews, and this task exists specifically as the safe alternative to that.

**L24-7 — the setup conversation.** A merchant describes what they want in plain English and `setup-conversation.ts`'s `draftSetupProposal()` — the one model call this feature makes — turns it into a proposal: a name, a purpose, a cap with a stated reason, and a capability set that is the *minimum* for the job, never the full set. Zod-validated (`setup-conversation-schema.ts`) into a closed shape before it is ever rendered; a malformed model output degrades to the existing manual per-agent form, never to a partial write. `setup-conversation-confirm.ts` is the only module that writes an `agents`/`spend_caps`/`agent_capabilities` row from this flow, and `setup-conversation.ts` — the module holding the model call — has **zero import of it**, asserted statically by `setup-conversation.isolation.test.ts`. This is the fifth instance of this codebase's model-holds-no-pen structural proof, after memory (Layer 18), the Trust Score (Layer 25), the returns desk (Layer 22), and the standalone buyer agent (Layer 19). Nothing is created until one explicit confirmation, and the whole batch — every proposed agent — is created together or not at all, since a half-configured fleet is worse than an empty one.

**L24-8 — Shadow Mode.** `merchant_shadow_mode` is a presence table — a row means on, absence means off — checked directly inside `attemptMoneyAction()` (gate contract point 19), which force-overwrites the incoming request to `dryRun: true, shadowModeForced: true` before `checkBounds` ever runs, regardless of what the individual caller passed. This reuses the real dry-run path Layer 13's preflight simulator already proved correct — `checkBounds`'s existing equivalence tests already establish that a dry run produces the identical deny reason a real attempt would — so shadow mode adds no new arithmetic, only a new reason a dry run was forced. Every simulated outcome writes a `shadow_mode_evaluated` audit entry with `decision: "n/a"`, distinct from `preflight_evaluated` so a merchant's decision stream can tell a one-off simulation request from an entire merchant running in shadow mode, even though both share the identical non-execution guarantee.

**L24-9 — integration verification, surfaced.** `integration-verify.ts` runs `thirdman doctor`'s real checks — origin allowlisted, discovery document resolving, MCP handshake succeeding, a linked agent key still authenticating — from the dashboard on demand, against the merchant's real live site. The checks already existed in Layer 20's CLI; this is the same logic with no terminal required.

**L24-10 — non-empty day one.** `onboarding-defaults.ts` gives a new merchant a real, clearly-labelled-as-a-default starting spend cap and policy — a real row the merchant can see and change, matching `EmptyState`'s existing no-fake-rows discipline exactly: a real default configuration is not fabricated data, a fake transaction would be, and there are none here.

**Tests (L24-11): 103 new, zero mocks.** `store-checks.test.ts` (20) and `shared/store-readiness-checks.test.ts` (9) prove the shared predicates directly — the same file both audits import, so these tests cover both by construction. `store-fetch.test.ts` (7) proves the fetching discipline against a real local HTTP server, matching `webhooks/deliver.test.ts`'s own no-mocked-fetch convention rather than mocking `fetch()`. `shopify.test.ts` (14) stands up that same kind of local server in place of Shopify's own token-exchange and Admin API endpoints and proves the encrypted-storage round trip, single-use state redemption, cross-merchant shop refusal, the real catalogue-to-`ImportRowPreview` mapping, and that nothing is written before `confirmShopifySync()` is called. `setup-conversation.isolation.test.ts` (3) is the structural proof; `shadow-mode.test.ts` (5) proves non-execution at the gate with real calls. The remaining count is split across `store-audit.test.ts`, `src/app/api/audit/route.test.ts`, `src/app/api/shopify/{install,callback}/route.test.ts`, `setup-conversation-confirm.test.ts`, `woocommerce-plugin.test.ts`, `integration-verify.test.ts`, `integration-artifacts.test.ts`, `onboarding-defaults.test.ts`, `unsupported-platform-spec.test.ts`, and `vscode-extension/src/diagnostics.test.ts`.

**The failure demos (L24-12).** `scripts/demo-failure-setup-cannot-self-approve.ts` — the setup conversation proposes a generous fleet against a real Groq call; whatever it proposes, the demo shows it ending as a pending, unconfirmed draft with no agent created and no cap written, the same headline shape as Layer 22's returns demo: the model said yes, and nothing moved. `scripts/demo-failure-cli-refuses-unsafe-write.ts` (Layer 20) shares this layer's exact governing rule and is exercised again here for the same reason.

**What's deliberately not built this session.** A public Shopify App Store listing — a real review step outside this project's control; the custom/unlisted app on a real dev store exercises every identical code path (see DECISIONS.md). JSON-LD generation beyond what WooCommerce's own hooks already add. A general crawler archive of fetched Instant Audit pages. Auto-approval at any threshold in the setup conversation. Automatic action from Shadow Mode's simulated output. See plans/layer-24-onboarding-surfaces.md's own task-level "Deliberately not built" notes.

## Scripts

Everything under `scripts/` runs via `npm run script <path>`, which wraps `node --env-file=.env.local -r tsx/cjs` — Node 22's native env-file loading, no `dotenv` dependency.

| Script | Purpose |
|---|---|
| `scripts/seed.ts` | Idempotent demo data: one merchant, 15 products, 2 agents (one active, one revoked) with randomly generated keys |
| `scripts/integration-proof.ts` | L0-8 — the full chain, config → order → money_action → audit entry → readback |
| `scripts/demo-failure-cap-exceeded.ts` | L1-5 scenario 1: an agent exceeds its cap, denied with a readable reason. Repeatable, self-cleaning (try/finally) |
| `scripts/demo-failure-razorpay-rejection.ts` | L1-5 scenario 2: a genuine Razorpay rejection after reservation, budget released. Repeatable, self-cleaning |
| `scripts/demo-failure-no-razorpay-connected.ts` | L2-2's failure demo: a merchant with no connected Razorpay account is denied before any budget is reserved. Repeatable, self-cleaning |
| `scripts/demo-failure-recovery-stopped.ts` | L3-6's Track 03 failure demo: the recovery agent tries, tries again, then stops itself at its attempt ceiling — a deterministic rule, not a crash. Repeatable, self-cleaning |
| `scripts/demo-recovery-batch.ts` | L3-6, updated L4-3: loads the demo failure batch, runs a full recovery batch, and prints every real, payable Razorpay Payment Link generated — paying one (test mode) moves it from `pending` to `succeeded`. Repeatable, self-cleaning |
| `scripts/demo-failure-out-of-stock.ts` | L4-8: two agents concurrently buy the last item in stock — exactly one succeeds, the other denied cleanly, stock and the denied agent's budget both left untouched. Repeatable, self-cleaning |
| `scripts/demo-failure-embed-origin.ts` | L10's failure demo: a request bearing a real embed key but a disallowed Origin is denied before the LLM is ever called, with a real `embed_origin_denied` audit entry read back. Repeatable, self-cleaning |
| `scripts/demo-failure-mandate-expired.ts` | L13-6: a real ES256-signed Checkout Mandate, minted already-expired, is refused before the model or the gate is ever consulted. Repeatable, self-cleaning |
| `scripts/demo-failure-mandate-tampered.ts` | L13-6: a cart total altered after signing is refused on the `checkout_hash`/amount mismatch, in integer paise — never a float or a tolerance. The same mandate still redeems correctly at the honest amount. Repeatable, self-cleaning |
| `scripts/demo-failure-capability-denied.ts` | L13-6: a fully legitimate, unrevoked, well-funded agent is refused a purchase purely on a missing `purchase:create` capability — nothing about its identity or budget is wrong. Repeatable, self-cleaning |
| `scripts/demo-failure-guardian-trip.ts` | L13-6: a real retry-loop pattern trips the Runtime Guardian across two real evaluations (normal → throttled → suspended), the next purchase is denied with zero budget reserved, a real merchant notification is enqueued, and a merchant re-arm restores normal operation. Repeatable, self-cleaning |
| `scripts/demo-failure-treasury-exhausted.ts` | L14-6: a use case's AI model budget is set to exactly what a real prior Groq call cost, then the very next real call for that use case degrades deterministically to the cheapest known tier instead of overspending, with a real audit entry naming the bound. Repeatable, self-cleaning |
| `scripts/demo-failure-armor-injection.ts` | L16-6: a real prompt-injection attempt in buyer chat is refused by model armor's deterministic pass before any model is called, with a real `model_armor_blocked` audit entry read back — and the same conversation completes normally right after. Repeatable, self-cleaning |
| `scripts/demo-failure-task-abandoned.ts` | L17-6: a real task fails repeatedly against a real failing step on a real backoff schedule, and is abandoned deterministically at exactly its attempt ceiling — never silently retried forever — with a real, bound-named audit entry read back. Repeatable, self-cleaning |
| `scripts/demo-failure-memory-injection.ts` | L18-8: a real buyer chat attempts to plant an instruction-override memory — refused at validation, never confirmed or retrievable — while a benign stated preference in the same conversation is correctly extracted, confirmed, and retrieved in a genuinely new session. Repeatable, self-cleaning |
| `scripts/demo-memory-does-not-move-the-gate.ts` | L18-8: the identical purchase, same agent, same cap, is denied with byte-identical decision and reason with and without a rich, deliberately adversarial memory bank planted for that agent — the layer's central rule demonstrated directly. No LLM call; repeatable, self-cleaning |
| `scripts/demo-failure-reservation-abandoned.ts` | L23's required failure demo: a reservation stranded by a process that never comes back (budget and stock reserved, `reservationExpiresAt` backdated to simulate real time passing with nothing left to catch it) is found by the real sweep, released, and audited with `boundApplied: "reservation_timeout"`. Repeatable, self-cleaning |
| `scripts/seed-buyer-agent.ts` | L19: provisions the persistent scenario `agent-buyer/` runs against — a real agent (narrow, deliberately-incomplete capabilities), a ₹2000 cap, and a catalogue tuned so the naive purchase overspends and only a negotiated price completes it. Idempotent, matching `seed.ts`'s own discipline; not self-cleaning (state is meant to persist between live runs) — see `reset-buyer-agent.ts` |
| `scripts/reset-buyer-agent.ts` | L19: clears the buyer-agent scenario's transactional state (open negotiations, `money_actions`, `spentPaise`) between live runs, without re-provisioning the agent/cap/catalogue |
| `scripts/demo-failure-buyer-overspends.ts` | L19's required failure demo: a real MCP client/server pair (in-process, `InMemoryTransport`) — the exact protocol shape `agent-buyer/`'s own MCP client uses — calls `purchase` for a quantity that exceeds the cap, refused with the existing reason, spend cap read back unchanged. No live model call (see FAILURES.md). Repeatable, self-cleaning |
| `scripts/demo-failure-rate-limit-shared.ts` | L26's required failure demo: two simulated instances alternate real `checkRateLimit` calls against one key — the limit holds across both combined, backed by exactly one shared `rate_limit_windows` row, proving the counter is genuinely shared state rather than a per-process bucket. Repeatable, self-cleaning |
| `scripts/demo-failure-kill-switch-holds.ts` | L25's required failure demo: an agent transacting normally, the Kill Switch thrown, the identical next real purchase attempt denied by the real guardian_state bound with `spentPaise` unchanged, then unfrozen and transacting again — the whole product in one script. Repeatable, self-cleaning |
| `scripts/demo-failure-return-cannot-self-approve.ts` | L22's headline failure demo: a real return conversation fed through the real recommendation pipeline (a genuine Groq call) still leaves the request `awaiting_merchant` and the money action untouched — whatever the model recommends, `returns-desk.ts` has no path to `issueRefund`. Repeatable, self-cleaning |
| `scripts/demo-failure-return-outside-window.ts` | L22's second failure demo: a return request against a purchase outside a published return window is refused deterministically, before any model call, with the real policy clause named in the audit reason. Repeatable, self-cleaning |
| `scripts/demo-failure-cli-refuses-unsafe-write.ts` | L20's required failure demo: `cli/`'s standalone CLI encounters a project where `.env.local` isn't gitignored and refuses to write a real-shaped agent key there, explaining why — `.env.local` is confirmed never created. Repeatable, self-cleaning |
| `scripts/check-*.ts` | Standalone verification scripts kept from each task, safe to re-run as smoke tests |

`npm run db:generate` / `db:migrate` / `db:studio` wrap `drizzle-kit`'s actual JS entry (`drizzle-kit/bin.cjs`) rather than its `.bin/` shim — see [FAILURES.md](FAILURES.md) for why the shim doesn't work directly under `node` on Windows.

## What's deliberately not here yet

- Razorpay OAuth ("Connect Razorpay") — needs partner app approval with an uncertain timeline; email/password + a merchant-pasted key pair (Layer 2-2, done) is the real version instead.
- Password reset / email verification — signup and login only.
- Multi-user-per-merchant (teams, roles) — one login per merchant, matching the unique-email schema.
- ~~Rate limiting is now real but minimal (Layer 4) — an in-memory, single-instance limiter~~ — resolved (Layer 26-1). `src/lib/rate-limit.ts`'s `checkRateLimit` is now Postgres-backed (`rate_limit_windows`, migration `0032`): a single atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < max` upsert, the same conditional-write primitive `reserveBudget`/`reserveStock`/`claimDueTasks` already prove correct under concurrency, quantized into epoch-aligned windows so every caller sharing a window contends on one row. Genuinely shared across instances — verified directly by `rate-limit.test.ts`'s 20-concurrent-against-a-limit-of-5 test and by `scripts/demo-failure-rate-limit-shared.ts`. The public signature (`checkRateLimit(key, max, windowMs)`, now async, and `getClientIp`) is unchanged in shape at every call site. Fails closed on a query error (denies and logs) rather than allowing unlimited traffic through a broken guard. Stale windows are swept via `/api/cron/run`'s new `rate-limit:sweep-stale` job. See DECISIONS.md for Postgres-over-Redis.
- **Buyer chat now exists (Layer 4-6)** — `/store/[merchantId]`'s chat widget, backed by `src/lib/chat.ts`. See "The buyer chat" above.
- **Live checkout now exists (Layer 4-2)** — Razorpay Checkout on the public storefront and the escrow demo both complete a real test-mode payment, verified by signature and/or webhook. `recovery_attempts.recovered_paise` can now show a genuine non-zero figure once a recovery Payment Link is actually paid (Layer 4-3) — see DECISIONS.md and FAILURES.md.
- ~~Customer messaging (email/SMS/WhatsApp) is still not wired~~ — email is resolved (Layer 11-4): `recovery/sequencer.ts`'s `deliverRecoveryLink()` now enqueues a real, deterministic email the moment a recovery Payment Link is created, delivered through the real notification queue (see "Notifications" above). SMS/WhatsApp are still not wired — only email is implemented, and the `notification_deliveries.channel` column exists so a second channel is a row value, not a schema migration, when/if it's ever built.
- ~~Real webhook delivery still not exercised end to end~~ — resolved (Layer 8-7). `/api/webhooks/razorpay` handles `payment.failed`, `payment.captured`/`order.paid`, and `payment_link.paid`, all signature-verified and idempotent by event id (`webhook_events`), and has now been exercised by a genuine unprompted Razorpay delivery via an ngrok tunnel + a real dashboard webhook registration — confirmed by real `webhook_events` rows and an audit entry reading "verified via the payment.captured webhook." See FAILURES.md for the four-cause misconfiguration chase it took to get there.
- No bank-outage pattern detection or checkout-friction diagnosis (prd.md §8) — both need failure/traffic volume this single-merchant demo product doesn't have.
- Escrow (Layer 4-5) is demo-scoped: the merchant triggers their own hold against their own product from `/dashboard/escrow` to demonstrate the mechanism (see DECISIONS.md on why a genuine two-agent buyer/seller escrow wasn't built) — the underlying gate functions (`captureHeldPayment`, `issueRefund`, `sweepExpiredHolds`) are real and would work identically for a genuine two-party flow.
- WhatsApp — still explicitly out of scope (Business API approval, uncertain timeline). Web chat only.
- Shipping, tax, addresses, multi-currency — not this product's story; the schema is INR-paise-everywhere and there is no fulfilment model.
- **Multi-line carts (Layer 6)** — an accepted upsell offer replaces the cart's single line with the bundle rather than adding a second line; a real multi-item cart needs the gate's stock reservation and idempotency semantics rethought as its own task, not built here (see DECISIONS.md).
- **Reward coin redemption is not wired into a single checkout UI step (Layer 6-5)** — `POST /api/checkout/redeem-coins` is a real, standalone, gated money action, independently tested, but no storefront/chat surface yet lets a buyer redeem coins as part of paying for a purchase in one flow.
- **Abandonment-to-upsell recovery strategy (Layer 6-6, prd.md §5 idea #2) — not built.** `payment_failures` (Layer 3) has no product/variant reference at all, so a genuinely product-aware reframe strategy needs real schema work (linking a failure to what was being bought), not just a new `policy.ts` branch. Deliberately cut rather than half-built with a fake stock signal — see DECISIONS.md.
- **The embeddable widget now exists (Layer 10)** — see "The embeddable widget" above. It is deliberately **not** a new authentication boundary: the buyer endpoints it calls were already public and unauthenticated before this layer, and its publishable key adds origin binding, a kill switch, and attribution, nothing more. Origin allowlisting stops a browser from loading the widget on an unlisted site; it does not, and cannot, stop a server-side script that sets its own `Origin` header, because those endpoints are public by design either way.
- ~~The outbound webhook runner needs a real scheduler~~ — resolved twice over. `webhooks/runner.ts`'s `drainDueDeliveries()` is trigger-agnostic by design (no worker process of its own) and is wired into `POST /api/cron/run`'s job list (Layer 11), confirmed live via a real authenticated `curl` returning `{"job":"webhooks:drain","ok":true}`. That route needed a real external scheduler actually pointed at it in a live deployment — **resolved by Layer 23-1: Cloud Scheduler now drives `/api/cron/run` every minute against the real deployed origin, see DEPLOYMENT.md.** Vercel's own cron (at most daily on the free tier) was never going to be enough; Cloud Scheduler both closes this gap for real and is the Google submission's required Google Cloud infrastructure proof — the same change satisfies both.
- **The Agent Runtime has no worker process (Layer 17, by design, not a gap)** — a task's state is entirely rows, advanced only when `/api/cron/run`'s tick fires. A task's `runAfter` is honored on the *next* tick, not at the instant it becomes due. **Layer 23-1's Cloud Scheduler (1-minute cadence) is that external scheduler in production** — chosen specifically at 1 minute, not a looser interval, because Layer 23-2's `RESERVATION_TIMEOUT_MINUTES` (5 minutes, `gate.ts`) is the tightest deterministic deadline this codebase now sweeps against; a looser tick would still be correct (a late tick runs correctly, just late) but would visibly lag that bound. The correctness of every state machine here never depended on tick frequency — only the felt responsiveness did, and that's now bounded for real.
- **Only one task kind exists (`recovery_sequence`)** — the runtime itself is general-purpose (any kind registers a zod state schema and a step handler), but only one real workload has been migrated onto it, deliberately, per the plan's own "prove it with one real migration, not five rushed ones."
- ~~The in-memory rate limiter (Layer 4, still true post-Layer-10, and post-Layer-23 deployment)~~ — resolved (Layer 26-1). See above.
- **The read-to-purchase ratio (Layer 23-3) is a running counter, not a rolling window** — `agents.catalogueReadCount` increments forever, never resets; `computeReadPurchaseRatio()` in `guardian.ts` divides it by a real count of that agent's `money_actions` rows. This is genuinely durable (a DB column, unlike the in-memory rate limiter above) and correct as a lifetime ratio, but it does mean an agent that browsed heavily once, months ago, and now buys normally still carries that history in its denominator forever — there's no time-decay. Surfacing only, on `/dashboard/guardian`'s "Shopping vs. buying" section; nothing here blocks a request, per the plan's explicit "surfacing is not blocking" constraint.
- **No embed origin wildcard support** — exact origins only. A merchant with several subdomains lists several origins. See DECISIONS.md for why a `*.example.com` pattern was left out rather than half-built.
- **No nginx/reverse proxy, no Redis, no account lockout, no hardcoded auth exemption, no WAF/DDoS/bot detection, no 2FA (Layer 26)** — all deliberately rejected by plans/layer-26-hardening.md's own "Deliberately not built" section; see there for the per-item reasoning (Cloud Run already does what a proxy would; Postgres already does what Redis would; a lockout is a DoS surface aimed at the merchant; a hardcoded exemption is a public-repo backdoor).
- **No nonce-per-request CSP** (Layer 26-4) — the dashboard/store CSP's `script-src`/`style-src` carry `'unsafe-inline'` rather than a per-request nonce, since Next's own app-router hydration payload and Tailwind's inline styles both need it and this stack has no nonce-threading infrastructure through Server Components. `frame-ancestors`, `object-src`, and `base-uri` — the directives that actually matter for clickjacking and injection-via-protocol here — are unaffected by this. A genuine XSS-hardening pass with real nonce wiring is a real follow-on, not this layer.
- **Notifications now exist (Layer 11)** — see "Notifications" above. SMS/WhatsApp are not wired, only email. No marketing/broadcast email — every notification this codebase sends is transactional, triggered by a real event concerning that specific recipient; there is no campaign or mailing-list feature and none is planned. No i18n — English only, matching the rest of the product. No buyer preference centre beyond one-click unsubscribe — that needs buyer accounts, which this product intentionally doesn't have (the storefront is session-based).
- **The notification queue's provider is Resend, and needs a real key in production** — without `RESEND_API_KEY` configured, every notification still exercises the full queue/bounds/audit trail but only ever reaches a console log, never a real inbox. See DECISIONS.md.
- ~~AI-credit tiers span only what one Groq key can serve~~ — resolved (Layer 16). `llm.ts` now genuinely reaches five providers (Groq, Gemini, NVIDIA, OpenRouter, Z.ai), each real, verified against its own live endpoint, and honestly labelled — `CompletionResult.provider` never claims a vendor that didn't actually serve the call. `ai-credits.ts`'s existing tiers are unchanged by this layer (still Groq-only); a multi-vendor credit tier is a follow-on task, not built here — see plans/layer-16-model-router-and-armor.md.
- **Model Armor (Layer 16-4) is a pattern-based scanner, not a semantic one** — real, checkable injection/PII shapes, honestly limited to that: a paraphrased disclosure or a novel injection phrasing outside the fixed pattern list isn't caught by the deterministic pass (the optional model second-opinion helps here but is off by default and can only escalate, never guarantee detection). No commercial guardrail vendor (Lakera, Prompt Armor, etc.) — a real dependency and a real per-call cost for a detection layer whose deterministic core this project can write and test itself; the calculus would differ at genuine production scale. No semantic PII detection, no separate armor service/sidecar — it is a function `llm.ts`'s callers call directly.
- **OpenRouter's listed pricing is a broker rate that can move** (Layer 16-2) — pinned to a specific model id with a real, cited rate at the time it was written, same snapshot caveat as every other row in `model-pricing.ts`, not a live-fetched price.
- **NVIDIA NIM has no one published token-price table for its whole hosted catalogue** (Layer 16-2) — its public pricing anchor is the NVIDIA AI Enterprise production license, not a commodity per-token bill, so only the one model this layer actually routes to (`nemotron-3-nano-30b-a3b`) has a real, verified per-token rate and is routable; the rest of NVIDIA's 80+ model catalogue is reachable via the same endpoint but deliberately not priced or routed here.
