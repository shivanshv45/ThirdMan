import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Same structural proof as rewards.isolation.test.ts, for the Recovery
 * section's chat bar.
 */
describe("recovery-draft.ts never imports the write path", () => {
  it("has no import of recovery-confirm.ts at all", () => {
    const source = readFileSync(new URL("./recovery-draft.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/recovery-confirm/);
    expect(source).not.toMatch(/from ["']@\/lib\/section-chat\/recovery-confirm/);
  });

  it("confirmRecoveryAction (the only executor) lives in recovery-confirm.ts, which never imports the LLM wrapper or recovery-draft.ts", () => {
    const confirmSource = readFileSync(new URL("./recovery-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/\bconfirmRecoveryAction\b/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/llm["']/);
    expect(confirmSource).not.toMatch(/from ["']\.\/recovery-draft["']/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/section-chat\/recovery-draft["']/);
  });

  it("draftRecoveryAction (the only model-caller) lives in recovery-draft.ts, which imports the LLM wrapper", () => {
    const source = readFileSync(new URL("./recovery-draft.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\bdraftRecoveryAction\b/);
    expect(source).toMatch(/from ["']@\/lib\/llm["']/);
  });

  it("confirm calls the same real functions the manual buttons call, never a parallel path", () => {
    const confirmSource = readFileSync(new URL("./recovery-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/from ["']@\/lib\/recovery\/demo-batch["']/);
    expect(confirmSource).toMatch(/from ["']@\/lib\/recovery\/sequencer["']/);
    expect(confirmSource).toMatch(/\bloadDemoFailureBatch\b/);
    expect(confirmSource).toMatch(/\brunRecoveryBatch\b/);
  });
});
