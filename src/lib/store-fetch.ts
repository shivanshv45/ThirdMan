/**
 * Layer 24-1's fetching discipline, in one place so every rule in the
 * plan (respect the target's robots.txt, identify ourselves, hard
 * timeout, hard byte limit, GET only, never retain content) is enforced
 * structurally rather than left to each caller to remember. The Instant
 * Audit is the only caller today; a crawler for someone else's site is a
 * genuinely different risk profile from anything else this codebase
 * fetches (Razorpay's own API, an LLM provider), so it gets its own
 * module rather than reusing an internal fetch helper.
 */

const USER_AGENT = "ThirdmanAuditBot/1.0 (+https://thirdman.dev/about-this-bot; agent-readiness audit, fetch-only, no retention)";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 2 * 1024 * 1024; // 2MB — enough for a real product/checkout page, not enough to hold a worker open on a pathological response
const MAX_PAGES_PER_AUDIT = 6; // homepage/product page + robots.txt + sitemap.xml + .well-known doc + checkout page + one more discovered product link

export interface FetchedPage {
  url: string;
  status: number;
  body: string;
  ok: true;
}

export interface FetchFailure {
  url: string;
  ok: false;
  reason: string;
}

export type FetchResult = FetchedPage | FetchFailure;

/**
 * A budget shared across every page fetched for one audit run —
 * enforces MAX_PAGES_PER_AUDIT across the whole run, not per call. Also
 * caches each origin's parsed robots.txt disallow list for the life of
 * the run, so checking five pages against the same origin fetches
 * robots.txt once, not five times — a real politeness requirement, not
 * just an efficiency one, since re-fetching the same robots.txt
 * repeatedly is itself a small unnecessary load on someone else's site.
 */
export class AuditFetchBudget {
  private pagesLeft = MAX_PAGES_PER_AUDIT;
  private robotsCache = new Map<string, Promise<string[] | null>>();

  hasPagesLeft(): boolean {
    return this.pagesLeft > 0;
  }

  consumeOne(): void {
    this.pagesLeft = Math.max(0, this.pagesLeft - 1);
  }

  /** Fetches (once per origin, cached) and returns the wildcard user-agent's disallow rules, or null if robots.txt could not be fetched. */
  getDisallowRules(origin: string): Promise<string[] | null> {
    const cached = this.robotsCache.get(origin);
    if (cached) return cached;

    const promise = (async () => {
      const result = await fetchPage(new URL("/robots.txt", origin).toString(), this, { skipRobotsCheck: true });
      if (!result.ok) return null;
      return parseWildcardDisallowRules(result.body);
    })();
    this.robotsCache.set(origin, promise);
    return promise;
  }

  /** Seeds the per-origin robots.txt cache from a fetch the caller already made for its own purposes (e.g. scoring robots.txt's own content), so a later isPathDisallowedByRobots call for the same origin never re-fetches it. */
  primeRobotsCache(origin: string, alreadyFetched: FetchResult): void {
    if (this.robotsCache.has(origin)) return;
    this.robotsCache.set(origin, Promise.resolve(alreadyFetched.ok ? parseWildcardDisallowRules(alreadyFetched.body) : null));
  }
}

function parseWildcardDisallowRules(robotsContent: string): string[] {
  const lines = robotsContent.split("\n").map((l) => l.trim());
  let applies = false;
  const disallowed: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("user-agent:")) {
      const agent = lower.slice("user-agent:".length).trim();
      applies = agent === "*"; // we only ever check the wildcard group — we make no special claim to be exempted by name
    } else if (applies && lower.startsWith("disallow:")) {
      const value = line.slice(line.toLowerCase().indexOf("disallow:") + "disallow:".length).trim();
      if (value) disallowed.push(value);
    }
  }
  return disallowed;
}

/**
 * Reports whether a path is disallowed by the target's own robots.txt
 * for our UA — the "audit a site while ignoring its own crawl
 * directives" contradiction the plan calls out explicitly must never
 * happen, even for our own audit fetch. Backed by the budget's
 * per-origin cache, so this never re-fetches robots.txt for a page
 * already checked against the same origin in this run.
 */
export async function isPathDisallowedByRobots(origin: string, path: string, budget: AuditFetchBudget): Promise<{ disallowed: boolean; robotsFetched: boolean }> {
  const disallowed = await budget.getDisallowRules(origin);
  if (disallowed === null) return { disallowed: false, robotsFetched: false };
  return { disallowed: disallowed.some((rule) => path === rule || path.startsWith(rule)), robotsFetched: true };
}

/**
 * Fetches one page under every limit the plan requires. Never follows a
 * form, never sends a body — GET only, always. Content is returned to
 * the caller to score and is never written anywhere by this module.
 */
export async function fetchPage(url: string, budget: AuditFetchBudget, opts: { skipRobotsCheck?: boolean } = {}): Promise<FetchResult> {
  if (!budget.hasPagesLeft()) {
    return { url, ok: false, reason: "Page budget for this audit run was exhausted." };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, ok: false, reason: "Not a valid URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { url, ok: false, reason: "Only http/https URLs can be audited." };
  }

  if (!opts.skipRobotsCheck) {
    const robotsCheck = await isPathDisallowedByRobots(parsed.origin, parsed.pathname, budget);
    if (robotsCheck.disallowed) {
      return { url, ok: false, reason: "This path is disallowed by the store's own robots.txt for general crawlers, so we did not fetch it." };
    }
  }

  budget.consumeOne();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8" },
    });

    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      return { url: parsed.toString(), ok: true, status: response.status, body: text.slice(0, MAX_BYTES) };
    }

    let received = 0;
    const chunks: Uint8Array[] = [];
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
    try {
      await reader.cancel();
    } catch {
      // best-effort — the byte cap was already enforced above
    }

    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8").slice(0, MAX_BYTES / 2);
    return { url: parsed.toString(), ok: true, status: response.status, body };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return { url: parsed.toString(), ok: false, reason: timedOut ? `Timed out after ${FETCH_TIMEOUT_MS / 1000}s.` : `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timeout);
  }
}
