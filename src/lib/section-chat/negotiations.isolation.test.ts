import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("negotiations-draft.ts never imports the write path", () => {
  it("has no import of negotiations-confirm.ts at all", () => {
    const source = readFileSync(new URL("./negotiations-draft.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/negotiations-confirm/);
    expect(source).not.toMatch(/from ["']@\/lib\/section-chat\/negotiations-confirm/);
  });

  it("confirmNegotiationsAction (the only executor) lives in negotiations-confirm.ts, which never imports the LLM wrapper or negotiations-draft.ts", () => {
    const confirmSource = readFileSync(new URL("./negotiations-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/\bconfirmNegotiationsAction\b/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/llm["']/);
    expect(confirmSource).not.toMatch(/from ["']\.\/negotiations-draft["']/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/section-chat\/negotiations-draft["']/);
  });

  it("draftNegotiationsAction (the only model-caller) lives in negotiations-draft.ts, which imports the LLM wrapper", () => {
    const source = readFileSync(new URL("./negotiations-draft.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\bdraftNegotiationsAction\b/);
    expect(source).toMatch(/from ["']@\/lib\/llm["']/);
  });

  it("confirm calls the same real mutation the manual form calls, never a parallel path", () => {
    const confirmSource = readFileSync(new URL("./negotiations-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/from ["']@\/lib\/dashboard-mutations["']/);
    expect(confirmSource).toMatch(/\bmutations\.setVariantNegotiationFloor\b/);
  });
});
