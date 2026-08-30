import { describe, it, expect } from "vitest";
import { artifactForCheck, artifactsForReport, type ArtifactContext } from "@/lib/integration-artifacts";
import { buildSnippet } from "../../shared/embed-snippet";

const ctx: ArtifactContext = { appOrigin: "https://app.example.com", publishableKey: "pk_test123" };

describe("artifactForCheck", () => {
  it("returns the exact same widget snippet buildSnippet would produce — never a re-derived copy", () => {
    const artifact = artifactForCheck("has_widget", ctx);
    expect(artifact).not.toBeNull();
    expect(artifact!.content).toBe(buildSnippet(ctx.appOrigin, ctx.publishableKey));
  });

  it("names an exact file/placement for every known check, not a vague description", () => {
    const artifact = artifactForCheck("robots_does_not_block_agents", ctx);
    expect(artifact!.placement).toMatch(/robots\.txt/);
    expect(artifact!.content).toContain("GPTBot");
  });

  it("returns null for a check with no generic paste-able fix, rather than fabricating one", () => {
    expect(artifactForCheck("no_human_only_checkout_gate", ctx)).toBeNull();
  });

  it("returns null for an unknown check id", () => {
    expect(artifactForCheck("totally_unknown_check", ctx)).toBeNull();
  });

  it("discovery document artifact points at the real, live per-merchant manifest, never a static value", () => {
    const artifact = artifactForCheck("has_discovery_document", ctx);
    expect(artifact!.content).toContain(ctx.appOrigin);
    expect(artifact!.content).toContain("/manifest.json");
  });
});

describe("artifactsForReport", () => {
  it("filters out checks with no known fix and preserves order for the rest", () => {
    const artifacts = artifactsForReport(["robots_does_not_block_agents", "no_human_only_checkout_gate", "has_widget"], ctx);
    expect(artifacts.map((a) => a.checkId)).toEqual(["robots_does_not_block_agents", "has_widget"]);
  });
});
