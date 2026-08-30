import { describe, it, expect } from "vitest";
import { generateUnsupportedPlatformSpec, type UnsupportedPlatformSpecContext } from "@/lib/unsupported-platform-spec";

const ctx: UnsupportedPlatformSpecContext = {
  merchantId: "11111111-1111-1111-1111-111111111111",
  merchantName: "Test Store",
  appOrigin: "https://app.example.com",
  publishableKey: "pk_test123",
};

describe("generateUnsupportedPlatformSpec", () => {
  it("is framed as a spec for a human to review, and explicitly warns against unsupervised AI execution", () => {
    const spec = generateUnsupportedPlatformSpec(ctx);
    expect(spec).toMatch(/not an instruction/i);
    expect(spec).toMatch(/review/i);
  });

  it("names the real merchant id and app origin, never a placeholder", () => {
    const spec = generateUnsupportedPlatformSpec(ctx);
    expect(spec).toContain(ctx.merchantId);
    expect(spec).toContain(ctx.appOrigin);
    expect(spec).toContain(ctx.publishableKey);
  });

  it("tells the merchant this is unverified until doctor/dashboard confirms it", () => {
    const spec = generateUnsupportedPlatformSpec(ctx);
    expect(spec).toMatch(/unverified/i);
    expect(spec).toMatch(/thirdman doctor/);
  });

  it("is byte-identical across two generations for the same input", () => {
    expect(generateUnsupportedPlatformSpec(ctx)).toBe(generateUnsupportedPlatformSpec(ctx));
  });

  it("never instructs a price as a formatted string, matching CLAUDE.md rule 3", () => {
    const spec = generateUnsupportedPlatformSpec(ctx);
    expect(spec).toMatch(/never a formatted string/i);
  });
});
