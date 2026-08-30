import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Layer 24-7's central test, per the plan's L24-11: "the setup
 * conversation cannot write a bound" — static half. The third instance
 * of this exact structural proof, after memory (Layer 18) and returns
 * (Layer 22): the module holding the model call has zero import of the
 * module that writes a row, and therefore no way to reach it.
 *
 * The behavioural half — a model output proposing a large fleet
 * produces a proposal awaiting confirmation and no agents/spend_caps
 * rows — is in setup-conversation-confirm.test.ts.
 */
describe("setup-conversation.ts never imports the write path", () => {
  it("has no import of setup-conversation-confirm.ts at all", () => {
    const source = readFileSync(new URL("./setup-conversation.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/setup-conversation-confirm/);
    expect(source).not.toMatch(/from ["']@\/lib\/setup-conversation-confirm/);
  });

  it("createProposedAgents (the only row-writer) lives in setup-conversation-confirm.ts, which never imports the LLM wrapper or setup-conversation.ts", () => {
    const confirmSource = readFileSync(new URL("./setup-conversation-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/\bcreateProposedAgents\b/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/llm["']/);
    expect(confirmSource).not.toMatch(/from ["']\.\/setup-conversation["']/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/setup-conversation["']/);
  });

  it("draftSetupProposal (the only model-caller) lives in setup-conversation.ts, which imports the LLM wrapper", () => {
    const source = readFileSync(new URL("./setup-conversation.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\bdraftSetupProposal\b/);
    expect(source).toMatch(/from ["']@\/lib\/llm["']/);
  });
});
