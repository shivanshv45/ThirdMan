# ThirdMan — Submission Video Script
**Target runtime: 4:45–5:00** · Founder narration over a live screen recording · Record each beat in one take against the real running app, don't fake footage.

Timestamps are guides, not law — pace to what feels natural when you say it out loud once. If a section runs long, cut adjectives before you cut a demo beat.

---

## 0:00–0:25 — Cold open, the problem (on camera or black screen with text, no product yet)

> "Give an AI agent your payment credential, and you've given it your bank account. That's not a metaphor — that's literally today's stack. There are exactly two positions: the agent has the key, or it doesn't.
>
> That's fine while the agent's a demo. It stops being fine the moment it's autonomous, runs unattended, and buys on behalf of a stranger.
>
> So I built the third position. Not the merchant. Not the buyer's agent. A third party, present at every transaction, that reads the merchant's rules and says no when it needs saying. I call it ThirdMan."

**[Cut to: landing page / dashboard homepage]**

---

## 0:25–0:55 — What it is, in one breath

> "ThirdMan is a merchant commerce platform with three front doors and one backend. A merchant dashboard for the human running the store. A buyer chat widget for a human customer. And a headless agent API — HTTP plus a native MCP server — for an external AI buyer. All three write to the same audit log, and all three go through the same gate before a rupee moves."

**[Screen: quick pan across dashboard nav — spend caps, audit trail, recovery, negotiations]**

> "The rule everything is built on: AI decides judgment. Code decides limits. The model can classify, negotiate, draft copy, recommend. It can never touch arithmetic."

---

## 0:55–1:40 — The gate, live (the core Track 01 moment)

**[Screen: buyer chat or agent API test — trigger a purchase attempt that will get denied for exceeding cap]**

> "Here's the gate in action. This is an AI buyer trying to check out. Watch what happens when it asks for more than its spend cap allows."

**[Show the denial come back — plain-English reason, HTTP 200, not an error]**

> "That's not a crash, and it's not a vague error — it's a 200 response with the exact reason: which bound applied, what the cap was, what it asked for. Every one of these decisions — allow, deny, escalate — writes to an audit log a merchant can see in real time."

**[Cut to: dashboard audit trail / live SSE decision feed updating]**

> "This feed is real. No polling, no mock data — Server-Sent Events pushing every decision the moment it lands. If I now buy something within budget—"

**[Trigger a successful purchase]**

> "—it goes through the same gate, the same checks, and shows up here too. Same pipe, different verdict."

---

## 1:40–2:10 — Revenue recovery (Track 03)

**[Screen: dashboard recovery pipeline]**

> "The second bar is revenue recovery. When a payment fails, ThirdMan diagnoses why — a deterministic lookup table first, and only an unclassified decline code ever reaches a model, which can only pick from a closed set of outcomes. Then it decides whether recovery is worth attempting, with a real ROI governor and a hard retry ceiling."

**[Show a recovery batch — real Razorpay Payment Links generated]**

> "These are real, payable Razorpay links — not placeholders. And this second number here—"

**[Point to the "restraint" metric]**

> "—is attempts the system deliberately didn't make. A pipeline that knows when to stop is the actual product."

---

## 2:10–2:50 — The reward coins → LLM credits loop (the memorable beat)

**[Screen: buyer chat — make a purchase, show coins earned, then redeem]**

> "Here's the part I like most. Customers earn reward coins on every purchase — a real money action, gated exactly like a purchase or a refund. But redemption doesn't give them a discount. It gives them working AI credits."

**[Show redemption flow — coins converting to a Groq-backed credit balance / usable API access]**

> "These are real Groq models, verified against Groq's own API before being wired in — never a fake balance. Shop, earn, and watch the coins become something you can actually call. It's a full loop: a commerce action turning into an AI capability, audited exactly like the purchase that funded it."

---

## 2:50–3:35 — Getting a merchant online: CLI, VS Code, Shopify/WooCommerce

**[Screen: terminal]**

> "None of this matters if a merchant can't actually plug in. So there's `npx thirdman init` — point it at your own store's repo—"

**[Run the CLI live against a small fixture repo or the demo store — show it detecting the stack, scoring readiness, and proposing a diff]**

> "It reads your real product data and routes, scores what an AI buyer can and can't do with your store today, and offers the integration as a diff — file by file, that you approve. It never writes a secret anywhere it hasn't checked your `.gitignore` first."

**[Cut to: VS Code extension — show a squiggle/diagnostic on a real line of code]**

> "The same audit engine also runs inside VS Code — so instead of a paragraph in a terminal telling you 'this price is a formatted string,' you get a squiggle on the actual line."

**[Cut to: WooCommerce plugin generation in the dashboard, or Shopify OAuth connect]**

> "And for merchants who aren't developers — which is most of them — there's a generated WooCommerce plugin, pre-filled with their own key, and a real Shopify OAuth app that syncs their catalogue with one click. Same audit engine underneath all of it, so the checks can't silently drift between surfaces."

---

## 3:35–4:05 — Trust and safety machinery (fast, don't over-explain)

**[Screen: dashboard — Guardian, Kill Switch, negotiation floor]**

> "A few more things happening under the hood, quickly. The Runtime Guardian watches every agent's own behavior against its trailing history and can throttle or suspend it automatically. There's a kill switch that freezes every agent at once, atomically, and remembers exactly how to restore them. Negotiation happens against a merchant-set floor the buyer can never actually see or derive. And every refusal can be signed — a cryptographic receipt that proves the system said no, not just a claim that it did."

**[Optional: quick flash of returns desk — "AI recommends, human decides, every time"]**

> "Even returns follow the same rule — the AI runs the whole conversation and makes a recommendation, but it structurally cannot approve its own refund. A human always does."

---

## 4:05–4:35 — Proof it's real, not a demo

**[Screen: quick flash of test output / FAILURES.md / a stat overlay]**

> "This isn't a mocked prototype. Seven hundred and forty-four tests, zero mocks — everything runs against a real database and a real Razorpay test account. The gate's been proven under actual concurrency: twenty simultaneous requests against a cap sized for five, exactly five allowed. I even built an adversarial AI buyer on Google's agent framework and pointed it at my own gate to try to break it — it got refused three different ways, adapted, and still completed its purchases inside the rules."

---

## 4:35–5:00 — Close

**[Cut back to landing page or a wide dashboard shot]**

> "Three front doors, one gate, one audit trail. The AI is free to be clever everywhere except the one place that actually moves money. That's ThirdMan — the third man between you and the buyer, holding the ledger, and saying no when it needs saying."

**[End card: product name, one-line tagline, optionally your name/team]**

---

## Recording notes

- **Cut list if you're running long:** trim the Guardian/Kill Switch/negotiation beat (3:35–4:05) first — it's the most "and also" section. Trim the CLI section second by skipping VS Code and just showing the terminal + WooCommerce.
- **Don't show:** internal schema diagrams, migration counts, or code on screen for more than 2–3 seconds — judges watch a pitch video for the product, not the codebase. Save that depth for the PPT.
- **Audio:** record narration and screen separately if possible, so a flubbed line doesn't cost you a full re-recording of a live demo action.
- **The one thing to nail:** the denial in the 0:55 beat has to look completely real — an actual 200 response with an actual reason string, not a canned example. That's the single moment that proves the whole pitch.
