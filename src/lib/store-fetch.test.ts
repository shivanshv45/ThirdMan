import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AuditFetchBudget, fetchPage, isPathDisallowedByRobots } from "./store-fetch";

/**
 * Layer 24-1's fetching discipline, exercised against a REAL local HTTP
 * server, not a mocked fetch — matching this codebase's genuine-
 * failures-only testing philosophy (DECISIONS.md), same pattern as
 * webhooks/deliver.test.ts.
 */

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.pop()!;
    await fn();
  }
});

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("fetchPage, against a real local server", () => {
  it("fetches a real page and returns its body", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>hello</body></html>");
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const budget = new AuditFetchBudget();
    const result = await fetchPage(`http://127.0.0.1:${port}/`, budget);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.body).toContain("hello");
    }
  });

  it("respects a robots.txt Disallow: / for the path it fetches", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("User-agent: *\nDisallow: /\n");
        return;
      }
      res.writeHead(200);
      res.end("should never be reached");
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const budget = new AuditFetchBudget();
    const result = await fetchPage(`http://127.0.0.1:${port}/products/1`, budget);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/robots\.txt/i);
    }
  });

  it("allows a fetch when robots.txt only disallows a different path", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("User-agent: *\nDisallow: /admin\n");
        return;
      }
      res.writeHead(200);
      res.end("<html>product page</html>");
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const budget = new AuditFetchBudget();
    const result = await fetchPage(`http://127.0.0.1:${port}/products/1`, budget);
    expect(result.ok).toBe(true);
  });

  it("enforces a hard byte limit on a pathological response", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200);
        res.end("");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      // Stream far more than the 2MB cap — the fetcher must stop reading, not buffer it all.
      const chunk = Buffer.alloc(64 * 1024, "a");
      let written = 0;
      const interval = setInterval(() => {
        if (written > 4 * 1024 * 1024 || res.destroyed) {
          clearInterval(interval);
          res.end();
          return;
        }
        res.write(chunk);
        written += chunk.length;
      }, 1);
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const budget = new AuditFetchBudget();
    const result = await fetchPage(`http://127.0.0.1:${port}/huge`, budget);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Body is capped well under the full 4MB the server tried to send.
      expect(result.body.length).toBeLessThan(2 * 1024 * 1024);
    }
  }, 15_000);

  it("times out against a server that never responds", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200);
        res.end("");
        return;
      }
      // never call res.end() — simulates a hung backend
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const budget = new AuditFetchBudget();
    const result = await fetchPage(`http://127.0.0.1:${port}/hangs`, budget);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/timed out/i);
    }
  }, 15_000);

  it("enforces a hard page-count limit across one audit's shared budget", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200);
        res.end("");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const budget = new AuditFetchBudget();
    let lastResult;
    // Each real page fetch also consumes one robots.txt fetch internally,
    // so the shared budget is exhausted well before 20 explicit calls.
    for (let i = 0; i < 20; i++) {
      lastResult = await fetchPage(`http://127.0.0.1:${port}/page-${i}`, budget);
    }
    expect(lastResult?.ok).toBe(false);
  }, 20_000);
});

describe("isPathDisallowedByRobots", () => {
  it("returns robotsFetched: false when robots.txt itself 404s, without treating that as disallowed", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const port = await listenOnEphemeralPort(server);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const budget = new AuditFetchBudget();
    const result = await isPathDisallowedByRobots(`http://127.0.0.1:${port}`, "/", budget);
    expect(result.disallowed).toBe(false);
  });
});
