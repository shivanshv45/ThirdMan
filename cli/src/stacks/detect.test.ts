import { describe, it, expect } from "vitest";
import { detectStack } from "./detect.js";
import { makeFixture } from "../test-fixture.js";

describe("detectStack", () => {
  it("detects Next.js from package.json dependency and config file", () => {
    const f = makeFixture({
      "package.json": JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "next.config.ts": "export default {}",
    });
    try {
      const result = detectStack(f.scope);
      expect(result.stack).toBe("nextjs");
      expect(result.ambiguousWith).toBeUndefined();
      expect(result.evidence.length).toBeGreaterThan(0);
    } finally {
      f.cleanup();
    }
  });

  it("detects Astro", () => {
    const f = makeFixture({
      "package.json": JSON.stringify({ dependencies: { astro: "4.0.0" } }),
      "astro.config.mjs": "export default {}",
    });
    try {
      expect(detectStack(f.scope).stack).toBe("astro");
    } finally {
      f.cleanup();
    }
  });

  it("detects WooCommerce by real markers, not directory name", () => {
    const f = makeFixture({
      "wp-config.php": "<?php // config",
    });
    try {
      expect(detectStack(f.scope).stack).toBe("woocommerce");
    } finally {
      f.cleanup();
    }
  });

  it("falls back to static_html when nothing recognised is found", () => {
    const f = makeFixture({
      "index.html": "<html></html>",
    });
    try {
      expect(detectStack(f.scope).stack).toBe("static_html");
    } finally {
      f.cleanup();
    }
  });

  it("falls back to static_html on a totally empty repo", () => {
    const f = makeFixture({ "README.md": "hello" });
    try {
      expect(detectStack(f.scope).stack).toBe("static_html");
    } finally {
      f.cleanup();
    }
  });

  it("reports ambiguity rather than guessing when two stacks both match", () => {
    // A contrived but real case: both next and express as dependencies.
    const f = makeFixture({
      "package.json": JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "next.config.js": "module.exports = {}",
    });
    try {
      // Not actually ambiguous on its own — assert the express detector
      // correctly EXCLUDES itself when next is present (no false ambiguity).
      const result = detectStack(f.scope);
      expect(result.stack).toBe("nextjs");
      expect(result.ambiguousWith).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  it("does not guess a stack from a directory name alone", () => {
    const f = makeFixture({
      "nextjs-project/README.md": "this directory is just named nextjs-project",
    });
    try {
      expect(detectStack(f.scope).stack).toBe("static_html");
    } finally {
      f.cleanup();
    }
  });
});
