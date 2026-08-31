import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The section chat bar's central proof, same structural discipline as
 * setup-conversation.isolation.test.ts (the fourth instance of it,
 * after memory, returns, and setup): the module holding the model call
 * has zero import of the module that writes a row, and therefore no
 * way to reach it. A chat bar that drafts changes is only safe under
 * CLAUDE.md's AI/code split if drafting and writing are structurally,
 * not just conventionally, separate.
 */
describe("rewards-draft.ts never imports the write path", () => {
  it("has no import of rewards-confirm.ts at all", () => {
    const source = readFileSync(new URL("./rewards-draft.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/rewards-confirm/);
    expect(source).not.toMatch(/from ["']@\/lib\/section-chat\/rewards-confirm/);
  });

  it("confirmRewardsAction (the only row-writer) lives in rewards-confirm.ts, which never imports the LLM wrapper or rewards-draft.ts", () => {
    const confirmSource = readFileSync(new URL("./rewards-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/\bconfirmRewardsAction\b/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/llm["']/);
    expect(confirmSource).not.toMatch(/from ["']\.\/rewards-draft["']/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/section-chat\/rewards-draft["']/);
  });

  it("draftRewardsAction (the only model-caller) lives in rewards-draft.ts, which imports the LLM wrapper", () => {
    const source = readFileSync(new URL("./rewards-draft.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\bdraftRewardsAction\b/);
    expect(source).toMatch(/from ["']@\/lib\/llm["']/);
  });

  it("confirm calls the same mutation functions the manual form uses, never a parallel write path", () => {
    const confirmSource = readFileSync(new URL("./rewards-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/from ["']@\/lib\/dashboard-mutations["']/);
    expect(confirmSource).toMatch(/mutations\.setRewardSettings/);
    expect(confirmSource).toMatch(/mutations\.createAiCreditTier/);
  });
});
