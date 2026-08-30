import { ProjectScope } from "../fs-scope.js";
import type { AuditCheck } from "../types.js";
import { robotsBlocksAgents as sharedRobotsBlocksAgents, sitemapReferencesProducts, hasProductStructuredData } from "../../../shared/store-readiness-checks.js";
import { findLineNumber } from "../../../shared/find-line.js";

/**
 * L20-3: discoverability checks — can an AI buyer even find this store's
 * products and terms. Every check is a real, deterministic read; no
 * model involved. A merchant blocking crawlers while wanting agent
 * buyers is a real, common, invisible mistake, so robots.txt gets its
 * own weighted check rather than being folded into "has a robots.txt."
 *
 * The judgment predicates (does robots.txt block agents, does structured
 * data exist, does the sitemap list products) come from
 * shared/store-readiness-checks.ts — the same file src/lib/store-checks.ts
 * imports — so this audit and the Instant Audit's cannot silently
 * diverge in what counts as a pass. Only the evidence-gathering (a real
 * file read here vs. a real HTTP fetch there) differs — L24-11.
 */

export function checkDiscoverability(scope: ProjectScope, allFiles: string[]): AuditCheck[] {
  const checks: AuditCheck[] = [];

  const wellKnownPath = allFiles.find((f) => f === ".well-known/agent-commerce.json" || f.endsWith(".well-known/agent-commerce.json"));
  checks.push({
    id: "has_discovery_document",
    label: "A /.well-known/agent-commerce.json discovery document exists",
    weight: 20,
    passed: wellKnownPath !== undefined,
    fix: wellKnownPath
      ? undefined
      : {
          message: "No agent discovery document found. Run `thirdman init` and confirm the generation step to add one.",
        },
  });

  const robotsPath = allFiles.find((f) => f === "robots.txt" || f.endsWith("/robots.txt") || f === "public/robots.txt");
  if (!robotsPath) {
    checks.push({
      id: "robots_txt_present",
      label: "robots.txt exists",
      weight: 5,
      passed: false,
      fix: { message: "No robots.txt found — not a blocker, but a merchant wanting agent buyers usually wants this explicit rather than absent." },
    });
  } else {
    const content = scope.readFile(robotsPath);
    const blocksAgentLikeCrawlers = sharedRobotsBlocksAgents(content);
    checks.push({
      id: "robots_txt_present",
      label: "robots.txt exists",
      weight: 5,
      passed: true,
    });
    checks.push({
      id: "robots_does_not_block_agents",
      label: "robots.txt does not block AI-agent user agents",
      weight: 15,
      passed: !blocksAgentLikeCrawlers,
      fix: blocksAgentLikeCrawlers
        ? {
            message: `${robotsPath} disallows a user agent that looks like an AI crawler (GPTBot, ClaudeBot, or a wildcard Disallow) — a merchant asking to be sold to by agents while blocking them is a real, common, invisible mistake.`,
            file: robotsPath,
            line: findLineNumber(content, /^\s*disallow:\s*\/\s*$/i) ?? undefined,
          }
        : undefined,
    });
  }

  const sitemapPath = allFiles.find((f) => f === "sitemap.xml" || f.endsWith("/sitemap.xml") || f === "public/sitemap.xml");
  let sitemapIncludesProducts = false;
  let sitemapContent = "";
  if (sitemapPath) {
    sitemapContent = scope.readFile(sitemapPath);
    sitemapIncludesProducts = sitemapReferencesProducts(sitemapContent);
  }
  checks.push({
    id: "sitemap_present",
    label: "A sitemap exists and includes product pages",
    weight: 10,
    passed: sitemapPath !== undefined && sitemapIncludesProducts,
    fix:
      !sitemapPath
        ? { message: "No sitemap.xml found — an agent has no efficient way to enumerate your product pages." }
        : !sitemapIncludesProducts
          ? { message: `${sitemapPath} exists but doesn't appear to reference product pages.`, file: sitemapPath, line: findLineNumber(sitemapContent, /<urlset|<sitemapindex/i) ?? undefined }
          : undefined,
  });

  const productPageFiles = allFiles.filter((f) => /product/i.test(f) && (f.endsWith(".tsx") || f.endsWith(".jsx") || f.endsWith(".html") || f.endsWith(".php")));
  const anyHasStructuredData = productPageFiles.some((f) => {
    const content = safeRead(scope, f);
    return content !== null && hasProductStructuredData(content);
  });
  checks.push({
    id: "product_structured_data",
    label: "Product pages carry schema.org/Product structured data",
    weight: 20,
    passed: productPageFiles.length > 0 && anyHasStructuredData,
    fix:
      productPageFiles.length === 0
        ? { message: "No product page files were located to check for structured data." }
        : !anyHasStructuredData
          ? { message: "No schema.org/Product JSON-LD found on any detected product page. An agent that has to OCR a price from an image cannot buy — run `thirdman init` and confirm the JSON-LD generation step if your stack supports it." }
          : undefined,
  });

  return checks;
}

function safeRead(scope: ProjectScope, relativePath: string): string | null {
  try {
    return scope.readFile(relativePath);
  } catch {
    return null;
  }
}
