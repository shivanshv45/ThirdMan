import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("products-draft.ts never imports the write path", () => {
  it("has no import of products-confirm.ts at all", () => {
    const source = readFileSync(new URL("./products-draft.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from ["']\.\/products-confirm/);
    expect(source).not.toMatch(/from ["']@\/lib\/section-chat\/products-confirm/);
  });

  it("confirmProductsAction (the only executor) lives in products-confirm.ts, which never imports the LLM wrapper or products-draft.ts", () => {
    const confirmSource = readFileSync(new URL("./products-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/\bconfirmProductsAction\b/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/llm["']/);
    expect(confirmSource).not.toMatch(/from ["']\.\/products-draft["']/);
    expect(confirmSource).not.toMatch(/from ["']@\/lib\/section-chat\/products-draft["']/);
  });

  it("draftProductsAction (the only model-caller) lives in products-draft.ts, which imports the LLM wrapper", () => {
    const source = readFileSync(new URL("./products-draft.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/\bdraftProductsAction\b/);
    expect(source).toMatch(/from ["']@\/lib\/llm["']/);
  });

  it("confirm calls the same real mutation the manual form calls, never a parallel path", () => {
    const confirmSource = readFileSync(new URL("./products-confirm.ts", import.meta.url), "utf-8");
    expect(confirmSource).toMatch(/from ["']@\/lib\/dashboard-mutations["']/);
    expect(confirmSource).toMatch(/\bmutations\.createProduct\b/);
  });
});
