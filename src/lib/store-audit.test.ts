import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { like } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { runInstantAudit, getCachedAuditReport } from "./store-audit";

/**
 * Layer 24-1's end-to-end orchestration, against a real local HTTP
 * server standing in for a third-party storefront — matching this
 * codebase's genuine-failures-only testing philosophy (DECISIONS.md).
 */

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.pop()!;
    await fn();
  }
  await db.delete(schema.instantAuditCache).where(like(schema.instantAuditCache.url, "http://127.0.0.1:%"));
});

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

const READY_STORE_HTML = `<html><head><script type="application/ld+json">{"@type":"Product","sku":"SHOE-42","name":"Running Shoe"}</script></head><body><a href="/checkout">Checkout</a></body></html>`;
const CHECKOUT_HTML_NO_CAPTCHA = `<html><body><button>Pay now</button></body></html>`;
const CHECKOUT_HTML_WITH_CAPTCHA = `<html><body><div class="g-recaptcha"></div><button>Pay now</button></body></html>`;

function makeReadyStoreServer(checkoutHtml: string): Server {
  return createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end("<urlset><url><loc>/products/shoe</loc></url></urlset>");
      return;
    }
    if (req.url === "/.well-known/agent-commerce.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"schemaVersion":"1.1"}');
      return;
    }
    if (req.url === "/checkout") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(checkoutHtml);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(READY_STORE_HTML);
  });
}

describe("runInstantAudit, against a real local storefront", () => {
  it("scores a well-configured store highly with every check passing", async () => {
    const server = makeReadyStoreServer(CHECKOUT_HTML_NO_CAPTCHA);
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const report = await runInstantAudit(`http://127.0.0.1:${port}/`);

    expect(report.score).toBe(100);
    expect(report.checks.every((c) => c.passed || c.notEvaluated)).toBe(true);
    expect(report.checks.find((c) => c.id === "has_discovery_document")?.passed).toBe(true);
    expect(report.checks.find((c) => c.id === "product_structured_data")?.passed).toBe(true);
    expect(report.checks.find((c) => c.id === "no_human_only_checkout_gate")?.passed).toBe(true);
  }, 20_000);

  it("fails the checkout check when a CAPTCHA is present, and never fabricates a pass", async () => {
    const server = makeReadyStoreServer(CHECKOUT_HTML_WITH_CAPTCHA);
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const report = await runInstantAudit(`http://127.0.0.1:${port}/`);
    const checkoutCheck = report.checks.find((c) => c.id === "no_human_only_checkout_gate");
    expect(checkoutCheck?.passed).toBe(false);
    expect(checkoutCheck?.fix?.message).toMatch(/captcha/i);
  }, 20_000);

  it("degrades honestly (notEvaluated, not a fabricated failure) when a check's own page couldn't be fetched", async () => {
    // Port 1 is reserved and nothing will ever be listening there.
    const report = await runInstantAudit("http://127.0.0.1:1/");
    // Checks whose evidence IS the fetch itself (the homepage, the checkout page) degrade to notEvaluated.
    expect(report.checks.find((c) => c.id === "homepage_reachable")?.notEvaluated).toBeTruthy();
    expect(report.checks.find((c) => c.id === "product_structured_data")?.notEvaluated).toBeTruthy();
    expect(report.checks.find((c) => c.id === "stable_item_identifier")?.notEvaluated).toBeTruthy();
    expect(report.checks.find((c) => c.id === "no_human_only_checkout_gate")?.notEvaluated).toBeTruthy();
    // Absence of robots.txt/sitemap/discovery-document is itself a real, correctly-scored finding (not a fetch failure to excuse) — never marked notEvaluated.
    expect(report.checks.find((c) => c.id === "robots_does_not_block_agents")?.notEvaluated).toBeFalsy();
    expect(report.checks.find((c) => c.id === "sitemap_lists_products")?.passed).toBe(false);
    expect(report.checks.find((c) => c.id === "has_discovery_document")?.passed).toBe(false);
  }, 20_000);

  it("flags a robots.txt that blocks agent crawlers", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("User-agent: *\nDisallow: /\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(READY_STORE_HTML);
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const report = await runInstantAudit(`http://127.0.0.1:${port}/`);
    const robotsCheck = report.checks.find((c) => c.id === "robots_does_not_block_agents");
    expect(robotsCheck?.passed).toBe(false);
  }, 20_000);

  it("caches the report by URL — a second call within the TTL does not refetch", async () => {
    let fetchCount = 0;
    const server = createServer((req, res) => {
      fetchCount++;
      if (req.url === "/robots.txt") {
        res.writeHead(200);
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(READY_STORE_HTML);
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const url = `http://127.0.0.1:${port}/`;
    await runInstantAudit(url);
    const countAfterFirst = fetchCount;
    expect(countAfterFirst).toBeGreaterThan(0);

    await runInstantAudit(url);
    expect(fetchCount).toBe(countAfterFirst);

    const cached = await getCachedAuditReport(url);
    expect(cached).not.toBeNull();
  }, 20_000);
});
