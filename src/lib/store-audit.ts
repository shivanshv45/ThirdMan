import { eq, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { AuditFetchBudget, fetchPage, type FetchResult } from "@/lib/store-fetch";
import { robotsBlocksAgents, sitemapReferencesProducts, hasProductStructuredData, hasStableItemIdentifier, checkoutRequiresHumanOnlyStep, computeStoreScore, type StoreCheck } from "@/lib/store-checks";

/**
 * Layer 24-1: the Instant Audit's orchestration — fetches a bounded set
 * of real pages from a real, arbitrary storefront and scores them with
 * store-checks.ts's pure predicates. Every check here is exactly the
 * plan's own list; no check exists that the plan didn't name.
 *
 * Report caching (by URL, 10 minutes) lives here rather than in the
 * route, so a direct call to runInstantAudit (e.g. from a future
 * surface) gets the same "fetched once" guarantee the route gets.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;

export interface StoreAuditReport {
  inputUrl: string;
  score: number;
  checks: StoreCheck[];
  fetchedAt: string;
  nextStep: string;
}

export async function getCachedAuditReport(url: string): Promise<StoreAuditReport | null> {
  const [row] = await db.select().from(schema.instantAuditCache).where(eq(schema.instantAuditCache.url, url));
  if (!row) return null;
  if (Date.now() - row.createdAt.getTime() > CACHE_TTL_MS) return null;
  return row.reportJson as StoreAuditReport;
}

async function storeAuditReport(url: string, report: StoreAuditReport): Promise<void> {
  await db
    .insert(schema.instantAuditCache)
    .values({ url, reportJson: report })
    .onConflictDoUpdate({ target: schema.instantAuditCache.url, set: { reportJson: report, createdAt: new Date() } });
}

function notEvaluatedCheck(id: string, label: string, weight: number, reason: string): StoreCheck {
  return { id, label, weight, passed: false, notEvaluated: { reason } };
}

/**
 * Runs the full Instant Audit against a real origin. Every fetch goes
 * through store-fetch.ts's shared budget, so the whole run (homepage,
 * robots.txt, sitemap.xml, the discovery document, and one product/
 * checkout page if discoverable) never exceeds the plan's page limit.
 * A page that could not be fetched degrades its own checks to
 * notEvaluated — never a fabricated failure (see store-checks.ts).
 */
export async function runInstantAudit(inputUrl: string): Promise<StoreAuditReport> {
  const cached = await getCachedAuditReport(inputUrl);
  if (cached) return cached;

  const origin = new URL(inputUrl).origin;
  const budget = new AuditFetchBudget();
  const checks: StoreCheck[] = [];

  // Fetched first and deliberately not through the budget's own
  // getDisallowRules cache path — this fetch is scored on its own
  // content (does robots.txt itself block agents), not used as a gate.
  // Every fetchPage call below reuses this same robots.txt via the
  // budget's per-origin cache (see store-fetch.ts), so it is fetched
  // from the wire exactly once per run regardless of how many pages
  // this audit checks against the same origin.
  const robots = await fetchPage(new URL("/robots.txt", origin).toString(), budget, { skipRobotsCheck: true });
  runRobotsChecks(checks, robots);
  budget.primeRobotsCache(origin, robots);

  const homepage = await fetchPage(inputUrl, budget);
  runHomepageChecks(checks, homepage);

  const sitemap = await fetchPage(new URL("/sitemap.xml", origin).toString(), budget);
  runSitemapChecks(checks, sitemap);

  const wellKnown = await fetchPage(new URL("/.well-known/agent-commerce.json", origin).toString(), budget);
  runDiscoveryDocumentChecks(checks, wellKnown);

  // Checkout gate check runs only if the homepage itself looks like a
  // checkout/cart page or plainly links to one we can still afford to
  // fetch under budget — never a guess at a URL that doesn't exist.
  if (homepage.ok) {
    const checkoutLink = findLikelyCheckoutLink(homepage.body, origin);
    if (checkoutLink && budget.hasPagesLeft()) {
      const checkoutPage = await fetchPage(checkoutLink, budget);
      runCheckoutChecks(checks, checkoutPage);
    } else {
      checks.push(notEvaluatedCheck("no_human_only_checkout_gate", "Checkout does not require a CAPTCHA or OTP step before price is visible", 15, "No checkout/cart page could be located from the homepage to check."));
    }
  } else {
    checks.push(notEvaluatedCheck("no_human_only_checkout_gate", "Checkout does not require a CAPTCHA or OTP step before price is visible", 15, "The homepage could not be fetched, so no checkout page could be discovered."));
  }

  const report: StoreAuditReport = {
    inputUrl,
    score: computeStoreScore(checks),
    checks,
    fetchedAt: new Date().toISOString(),
    nextStep: "Six of these can typically be fixed automatically — run `npx thirdman init` in the store's own codebase, or install the Shopify app once it's available.",
  };

  await storeAuditReport(inputUrl, report);
  return report;
}

function runHomepageChecks(checks: StoreCheck[], homepage: FetchResult): void {
  if (!homepage.ok) {
    checks.push(notEvaluatedCheck("homepage_reachable", "The store's homepage is reachable", 10, homepage.reason));
    checks.push(notEvaluatedCheck("product_structured_data", "Product pages carry schema.org/Product structured data", 20, "The homepage could not be fetched, so no page was available to check for structured data."));
    checks.push(notEvaluatedCheck("stable_item_identifier", "A stable SKU/id field exists per purchasable item", 15, "The homepage could not be fetched, so no page was available to check."));
    return;
  }

  checks.push({ id: "homepage_reachable", label: "The store's homepage is reachable", weight: 10, passed: true });

  const hasStructuredData = hasProductStructuredData(homepage.body);
  checks.push({
    id: "product_structured_data",
    label: "Product pages carry schema.org/Product structured data",
    weight: 20,
    passed: hasStructuredData,
    fix: hasStructuredData ? undefined : { message: "No schema.org/Product JSON-LD or microdata was found on the fetched page. An agent that has to OCR a price from rendered text cannot reliably buy from this store." },
  });

  const hasStableId = hasStableItemIdentifier(homepage.body);
  checks.push({
    id: "stable_item_identifier",
    label: "A stable SKU/id field exists per purchasable item",
    weight: 15,
    passed: hasStableId,
    fix: hasStableId ? undefined : { message: "No SKU, GTIN, or product id field was found — an agent has no stable identifier to reorder or reconcile against, only a URL." },
  });
}

function runRobotsChecks(checks: StoreCheck[], robots: FetchResult): void {
  if (!robots.ok) {
    // A missing robots.txt is a real, evaluable finding (not blocked, just absent) — never notEvaluated.
    checks.push({ id: "robots_does_not_block_agents", label: "robots.txt does not block AI-agent user agents", weight: 15, passed: true, fix: { message: "No robots.txt was found. Not a blocker on its own, but a merchant who wants agent buyers usually wants this explicit rather than absent." } });
    return;
  }
  const blocked = robotsBlocksAgents(robots.body);
  checks.push({
    id: "robots_does_not_block_agents",
    label: "robots.txt does not block AI-agent user agents",
    weight: 15,
    passed: !blocked,
    fix: blocked ? { message: "This store's robots.txt disallows the whole site to a user agent that looks like an AI crawler (GPTBot, ClaudeBot, or a wildcard Disallow: /). A merchant asking to be sold to by agents while blocking them at the door is a real, common, invisible mistake." } : undefined,
  });
}

function runSitemapChecks(checks: StoreCheck[], sitemap: FetchResult): void {
  if (!sitemap.ok) {
    checks.push({ id: "sitemap_lists_products", label: "A sitemap exists and includes product pages", weight: 10, passed: false, fix: { message: "No sitemap.xml was found at the site root — an agent has no efficient way to enumerate this store's product pages." } });
    return;
  }
  const includesProducts = sitemapReferencesProducts(sitemap.body);
  checks.push({
    id: "sitemap_lists_products",
    label: "A sitemap exists and includes product pages",
    weight: 10,
    passed: includesProducts,
    fix: includesProducts ? undefined : { message: "sitemap.xml exists but doesn't appear to reference product pages." },
  });
}

function runDiscoveryDocumentChecks(checks: StoreCheck[], wellKnown: FetchResult): void {
  const present = wellKnown.ok && wellKnown.status === 200;
  checks.push({
    id: "has_discovery_document",
    label: "A /.well-known/agent-commerce.json discovery document exists",
    weight: 20,
    passed: present,
    fix: present ? undefined : { message: "No agent discovery document was found at /.well-known/agent-commerce.json. This is the single document an AI buyer looks for first — without it, every other capability has to be guessed at.", href: "https://thirdman.dev/docs/discovery" },
  });
}

function runCheckoutChecks(checks: StoreCheck[], checkoutPage: FetchResult): void {
  if (!checkoutPage.ok) {
    checks.push(notEvaluatedCheck("no_human_only_checkout_gate", "Checkout does not require a CAPTCHA or OTP step before price is visible", 15, checkoutPage.reason));
    return;
  }
  const requiresHuman = checkoutRequiresHumanOnlyStep(checkoutPage.body);
  checks.push({
    id: "no_human_only_checkout_gate",
    label: "Checkout does not require a CAPTCHA or OTP step before price is visible",
    weight: 15,
    passed: !requiresHuman,
    fix: requiresHuman ? { message: "The checkout page appears to reference a CAPTCHA or OTP step — an AI buyer cannot complete this without a human present." } : undefined,
  });
}

function findLikelyCheckoutLink(homepageHtml: string, origin: string): string | null {
  const match = homepageHtml.match(/href=["']([^"']*(?:checkout|cart)[^"']*)["']/i);
  if (!match) return null;
  try {
    return new URL(match[1], origin).toString();
  } catch {
    return null;
  }
}

const CACHE_SWEEP_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Table hygiene, not a correctness concern — a cache row past every TTL any caller could honor is dead weight. Registered in /api/cron/run. */
export async function sweepStaleInstantAuditCache(): Promise<{ swept: number }> {
  const cutoff = new Date(Date.now() - CACHE_SWEEP_RETENTION_MS);
  const deleted = await db.delete(schema.instantAuditCache).where(lt(schema.instantAuditCache.createdAt, cutoff)).returning({ url: schema.instantAuditCache.url });
  return { swept: deleted.length };
}
