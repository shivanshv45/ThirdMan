import { ProjectScope } from "../fs-scope.js";
import type { DetectionResult, StackKind } from "../types.js";

/**
 * L20-2: deterministic, evidence-based stack detection. Every match
 * carries the real file(s) that caused it — no directory-name guessing.
 * Two or more real matches means ambiguousWith is set and the caller
 * must prompt rather than pick one, per the plan's explicit instruction.
 */

interface StackDetector {
  stack: StackKind;
  detect: (scope: ProjectScope) => string[]; // returns evidence paths, empty if no match
}

function readPackageJson(scope: ProjectScope): Record<string, unknown> | null {
  if (!scope.exists("package.json")) return null;
  try {
    return JSON.parse(scope.readFile("package.json"));
  } catch {
    return null;
  }
}

function hasDependency(pkg: Record<string, unknown> | null, name: string): boolean {
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
  return name in deps;
}

const DETECTORS: StackDetector[] = [
  {
    stack: "nextjs",
    detect: (scope) => {
      const evidence: string[] = [];
      const pkg = readPackageJson(scope);
      if (hasDependency(pkg, "next")) evidence.push("package.json (next dependency)");
      for (const f of ["next.config.js", "next.config.ts", "next.config.mjs"]) {
        if (scope.exists(f)) evidence.push(f);
      }
      return evidence;
    },
  },
  {
    stack: "remix",
    detect: (scope) => {
      const evidence: string[] = [];
      const pkg = readPackageJson(scope);
      if (hasDependency(pkg, "@remix-run/react") || hasDependency(pkg, "@remix-run/node")) evidence.push("package.json (@remix-run dependency)");
      for (const f of ["remix.config.js", "vite.config.ts"]) {
        if (scope.exists(f) && hasDependency(pkg, "@remix-run/dev")) evidence.push(f);
      }
      return evidence;
    },
  },
  {
    stack: "astro",
    detect: (scope) => {
      const evidence: string[] = [];
      const pkg = readPackageJson(scope);
      if (hasDependency(pkg, "astro")) evidence.push("package.json (astro dependency)");
      for (const f of ["astro.config.mjs", "astro.config.ts", "astro.config.js"]) {
        if (scope.exists(f)) evidence.push(f);
      }
      return evidence;
    },
  },
  {
    stack: "hydrogen",
    detect: (scope) => {
      const evidence: string[] = [];
      const pkg = readPackageJson(scope);
      if (hasDependency(pkg, "@shopify/hydrogen")) evidence.push("package.json (@shopify/hydrogen dependency)");
      return evidence;
    },
  },
  {
    stack: "express",
    detect: (scope) => {
      const evidence: string[] = [];
      const pkg = readPackageJson(scope);
      if (hasDependency(pkg, "express") && !hasDependency(pkg, "next") && !hasDependency(pkg, "@remix-run/node")) {
        evidence.push("package.json (express dependency)");
      }
      return evidence;
    },
  },
  {
    stack: "woocommerce",
    detect: (scope) => {
      const evidence: string[] = [];
      for (const f of ["wp-config.php", "woocommerce.php"]) {
        if (scope.exists(f)) evidence.push(f);
      }
      const files = scope.listFiles(".");
      if (files.some((f) => f.includes("wp-content/plugins/woocommerce"))) {
        evidence.push("wp-content/plugins/woocommerce/");
      }
      return evidence;
    },
  },
];

/**
 * Runs every detector and reports every real match. Exactly one match:
 * confident. Zero matches: falls back to static_html, the honest
 * fallback per the plan. Two or more: ambiguousWith is set — the caller
 * (init.ts) must prompt, never guess, since a wrong guess writes a file
 * in the wrong place, "the worst failure mode this tool has."
 */
export function detectStack(scope: ProjectScope): DetectionResult {
  const matches: { stack: StackKind; evidence: string[] }[] = [];
  for (const detector of DETECTORS) {
    const evidence = detector.detect(scope);
    if (evidence.length > 0) matches.push({ stack: detector.stack, evidence });
  }

  if (matches.length === 0) {
    const hasHtml = scope.listFiles(".").some((f) => f.endsWith(".html"));
    return {
      stack: "static_html",
      evidence: hasHtml ? ["at least one .html file found, no recognised framework dependency"] : ["no recognised framework or markup found"],
    };
  }

  if (matches.length === 1) {
    return { stack: matches[0].stack, evidence: matches[0].evidence };
  }

  return {
    stack: matches[0].stack,
    evidence: matches[0].evidence,
    ambiguousWith: matches.slice(1).map((m) => m.stack),
  };
}
