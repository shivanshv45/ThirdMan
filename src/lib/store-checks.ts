/**
 * Layer 24-1: the Instant Audit's own StoreCheck/computeStoreScore shape,
 * fed real fetched pages. The judgment predicates themselves
 * (robotsBlocksAgents, hasProductStructuredData, etc.) live in
 * ../../shared/store-readiness-checks.ts, re-exported here — that file is
 * the single source both this module and cli/'s audit engine import, so
 * "produces the same finding for the same input" (L24-11) is a property
 * of import identity, not something that can silently drift between two
 * copies. See that file's header for why evidence-gathering (HTTP fetch
 * here vs. filesystem read in cli/) still differs while judgment does not.
 */

export {
  robotsBlocksAgents,
  sitemapReferencesProducts,
  hasProductStructuredData,
  hasStableItemIdentifier,
  checkoutRequiresHumanOnlyStep,
  priceLooksLikeFormattedString,
} from "../../shared/store-readiness-checks";

export interface StoreCheck {
  id: string;
  label: string;
  weight: number;
  passed: boolean;
  /** Present only when the check genuinely failed — never set for a check that could not run at all. */
  fix?: { message: string; href?: string; file?: string };
  /** Present only when this check could not be evaluated (blocked fetch, timeout, no evidence). A check that did not run must never be scored as a failure — see the module header and CLAUDE.md's no-fabrication rule. */
  notEvaluated?: { reason: string };
}

/**
 * Weighted score over only the checks that actually ran. A check marked
 * notEvaluated contributes to neither the numerator nor the denominator
 * — honest degradation (plan L24-1) means a site we could not inspect
 * must not silently read as a low score.
 */
export function computeStoreScore(checks: StoreCheck[]): number {
  const evaluated = checks.filter((c) => !c.notEvaluated);
  const totalWeight = evaluated.reduce((sum, c) => sum + c.weight, 0);
  const earnedWeight = evaluated.filter((c) => c.passed).reduce((sum, c) => sum + c.weight, 0);
  return totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
}
