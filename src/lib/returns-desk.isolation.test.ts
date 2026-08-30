import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Layer 22's central test, per plans/layer-22-returns-desk.md's L22-7:
 * "no path exists from model output to issueRefund." Static proof that
 * returns-desk.ts — the module holding every model call in this layer
 * (the conversation turn and the recommendation) — never imports
 * gate.ts's issueRefund, matching the exact pattern
 * trust-score-never-influences-gate.test.ts and
 * memory-never-influences-gate.test.ts already established for their
 * own governing rules.
 *
 * The behavioural half of this proof —  a model recommending "approve"
 * produces a request still awaiting the merchant, no refund issued — is
 * in returns-desk.model-cannot-approve.test.ts.
 */
describe("returns-desk.ts never imports issueRefund", () => {
  it("has no import of gate.ts at all — the model-facing module has zero surface onto the gate, and therefore no way to reach issueRefund", () => {
    const source = readFileSync(new URL("./returns-desk.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']@\/lib\/gate/);
  });

  it("issueRefund is called only from returns-desk-decision.ts, a module returns-desk.ts never imports", () => {
    const deskSource = readFileSync(new URL("./returns-desk.ts", import.meta.url), "utf-8");
    expect(deskSource).not.toMatch(/from ["']\.\/returns-desk-decision/);

    const decisionSource = readFileSync(new URL("./returns-desk-decision.ts", import.meta.url), "utf-8");
    expect(decisionSource).toMatch(/from ["']@\/lib\/gate["']/);
    expect(decisionSource).toMatch(/\bissueRefund\b/);
  });
});
