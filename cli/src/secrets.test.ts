import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { envLocalIsGitignored, writeAgentKeyToEnvLocal, UnsafeSecretWriteError } from "./secrets.js";
import { makeFixture } from "./test-fixture.js";

describe("envLocalIsGitignored", () => {
  it("is true when .gitignore explicitly lists .env.local", () => {
    const f = makeFixture({ ".gitignore": "node_modules\n.env.local\n" });
    try {
      expect(envLocalIsGitignored(f.scope)).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("is true when .gitignore uses a .env* wildcard", () => {
    const f = makeFixture({ ".gitignore": ".env*\n" });
    try {
      expect(envLocalIsGitignored(f.scope)).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("is false with no .gitignore at all", () => {
    const f = makeFixture({ "README.md": "x" });
    try {
      expect(envLocalIsGitignored(f.scope)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("is false when .gitignore exists but does not cover .env.local — this is CLAUDE.md rule 5, enforced by the tool", () => {
    const f = makeFixture({ ".gitignore": "node_modules\ndist\n" });
    try {
      expect(envLocalIsGitignored(f.scope)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});

describe("writeAgentKeyToEnvLocal", () => {
  it("refuses to write when .env.local is not gitignored — the real refusal this layer's failure demo shows", () => {
    const f = makeFixture({ ".gitignore": "node_modules\n" });
    try {
      expect(() => writeAgentKeyToEnvLocal(f.scope, "THIRDMAN_AGENT_API_KEY", "sk_live_secret")).toThrow(UnsafeSecretWriteError);
      expect(existsSync(path.join(f.root, ".env.local"))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("writes a new .env.local when it is gitignored", () => {
    const f = makeFixture({ ".gitignore": ".env.local\n" });
    try {
      writeAgentKeyToEnvLocal(f.scope, "THIRDMAN_AGENT_API_KEY", "sk_live_secret");
      const content = readFileSync(path.join(f.root, ".env.local"), "utf8");
      expect(content).toContain("THIRDMAN_AGENT_API_KEY=sk_live_secret");
    } finally {
      f.cleanup();
    }
  });

  it("replaces an existing key in place rather than duplicating it", () => {
    const f = makeFixture({
      ".gitignore": ".env.local\n",
      ".env.local": "OTHER_VAR=1\nTHIRDMAN_AGENT_API_KEY=sk_old\n",
    });
    try {
      writeAgentKeyToEnvLocal(f.scope, "THIRDMAN_AGENT_API_KEY", "sk_new");
      const content = readFileSync(path.join(f.root, ".env.local"), "utf8");
      expect(content).toContain("THIRDMAN_AGENT_API_KEY=sk_new");
      expect(content).not.toContain("sk_old");
      expect(content).toContain("OTHER_VAR=1");
      expect((content.match(/THIRDMAN_AGENT_API_KEY=/g) ?? []).length).toBe(1);
    } finally {
      f.cleanup();
    }
  });
});
