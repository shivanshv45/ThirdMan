import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("policies-draft.ts never imports the write path", () => {
  it("has no import of policies-confirm.ts at all", () => {
    const source = readFileSync(new URL("./policies-draft.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/policies-confirm/);
    expect(source).not.toMatch(/from ["']@\/lib\/section-chat\/policies-confirm/);
  });

  it("confirmPoliciesAction (the only executor) lives in policies-confirm.ts, which never imports the LLM wrapper or policies-draft.ts", () => {
    const confirmSource = readFileSync(new URL("./policies-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/\bconfirmPoliciesAction\b/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/llm["']/);
    expect(confirmSource).not.toMatch(/from ["']\.\/policies-draft["']/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/section-chat\/policies-draft["']/);
  });

  it("draftPoliciesAction (the only model-caller) lives in policies-draft.ts, which imports the LLM wrapper", () => {
    const source = readFileSync(new URL("./policies-draft.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\bdraftPoliciesAction\b/);
    expect(source).toMatch(/from ["']@\/lib\/llm["']/);
  });

  it("confirm calls the same real mutation the manual form calls, never a parallel path", () => {
    const confirmSource = readFileSync(new URL("./policies-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/from ["']@\/lib\/dashboard-mutations["']/);
    expect(confirmSource).toMatch(/\bmutations\.setMerchantPolicy\b/);
  });
});
