import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("treasury-draft.ts never imports the write path", () => {
  it("has no import of treasury-confirm.ts at all", () => {
    const source = readFileSync(new URL("./treasury-draft.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/treasury-confirm/);
    expect(source).not.toMatch(/from ["']@\/lib\/section-chat\/treasury-confirm/);
  });

  it("confirmTreasuryAction (the only executor) lives in treasury-confirm.ts, which never imports the LLM wrapper or treasury-draft.ts", () => {
    const confirmSource = readFileSync(new URL("./treasury-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/\bconfirmTreasuryAction\b/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/llm["']/);
    expect(confirmSource).not.toMatch(/from ["']\.\/treasury-draft["']/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/section-chat\/treasury-draft["']/);
  });

  it("draftTreasuryAction (the only model-caller) lives in treasury-draft.ts, which imports the LLM wrapper", () => {
    const source = readFileSync(new URL("./treasury-draft.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\bdraftTreasuryAction\b/);
    expect(source).toMatch(/from ["']@\/lib\/llm["']/);
  });

  it("confirm calls the same real functions the manual buttons call, never a parallel path", () => {
    const confirmSource = readFileSync(new URL("./treasury-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/from ["']@\/lib\/treasury["']/);
    expect(confirmSource).toMatch(/from ["']@\/lib\/reward-rules["']/);
    expect(confirmSource).toMatch(/from ["']@\/lib\/model-router["']/);
    expect(confirmSource).toMatch(/\bsetTreasurySettings\b/);
    expect(confirmSource).toMatch(/\bcreateMerchantAuthoredRule\b/);
    expect(confirmSource).toMatch(/\bsetModelBudget\b/);
  });
});
