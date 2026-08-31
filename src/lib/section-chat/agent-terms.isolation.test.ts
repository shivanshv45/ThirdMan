import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("agent-terms-draft.ts never imports the write path", () => {
  it("has no import of agent-terms-confirm.ts at all", () => {
    const source = readFileSync(new URL("./agent-terms-draft.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/agent-terms-confirm/);
    expect(source).not.toMatch(/from ["']@\/lib\/section-chat\/agent-terms-confirm/);
  });

  it("confirmAgentTermsAction (the only executor) lives in agent-terms-confirm.ts, which never imports the LLM wrapper or agent-terms-draft.ts", () => {
    const confirmSource = readFileSync(new URL("./agent-terms-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/\bconfirmAgentTermsAction\b/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/llm["']/);
    expect(confirmSource).not.toMatch(/from ["']\.\/agent-terms-draft["']/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/section-chat\/agent-terms-draft["']/);
  });

  it("draftAgentTermsAction (the only model-caller) lives in agent-terms-draft.ts, which imports the LLM wrapper", () => {
    const source = readFileSync(new URL("./agent-terms-draft.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\bdraftAgentTermsAction\b/);
    expect(source).toMatch(/from ["']@\/lib\/llm["']/);
  });

  it("confirm calls the same real mutation the manual form calls, never a parallel path", () => {
    const confirmSource = readFileSync(new URL("./agent-terms-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/from ["']@\/lib\/agent-terms["']/);
    expect(confirmSource).toMatch(/\bsetMerchantAgentTerms\b/);
  });
});
