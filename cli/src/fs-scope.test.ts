import { describe, it, expect } from "vitest";
import { ProjectScope } from "./fs-scope.js";
import { makeFixture } from "./test-fixture.js";

describe("ProjectScope", () => {
  it("throws on any path that resolves outside the root", () => {
    const f = makeFixture({ "README.md": "x" });
    try {
      expect(() => f.scope.resolve("../outside.txt")).toThrow();
      expect(() => f.scope.resolve("../../etc/passwd")).toThrow();
      expect(() => f.scope.resolve("./nested/../../outside.txt")).toThrow();
    } finally {
      f.cleanup();
    }
  });

  it("allows a normal nested relative path", () => {
    const f = makeFixture({ "src/a/b.txt": "x" });
    try {
      expect(() => f.scope.resolve("src/a/b.txt")).not.toThrow();
    } finally {
      f.cleanup();
    }
  });

  it("excludes node_modules, .git, and build output from listFiles", () => {
    const f = makeFixture({
      "node_modules/pkg/index.js": "x",
      ".git/HEAD": "x",
      "dist/bundle.js": "x",
      "src/real.ts": "x",
    });
    try {
      const files = f.scope.listFiles(".");
      expect(files).toContain("src/real.ts");
      expect(files.some((p) => p.includes("node_modules"))).toBe(false);
      expect(files.some((p) => p.includes(".git/"))).toBe(false);
      expect(files.some((p) => p.startsWith("dist/"))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("excludes a gitignored path from listFiles", () => {
    const f = makeFixture({
      ".gitignore": "secrets/\n",
      "secrets/key.txt": "x",
      "src/real.ts": "x",
    });
    try {
      const files = f.scope.listFiles(".");
      expect(files).toContain("src/real.ts");
      expect(files.some((p) => p.startsWith("secrets/"))).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
