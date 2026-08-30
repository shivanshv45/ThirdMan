import { ProjectScope } from "../fs-scope.js";
import type { AuditCheck } from "../types.js";
import { priceLooksLikeFormattedString, hasSkuField } from "../../../shared/store-readiness-checks.js";
import { findLineNumber } from "../../../shared/find-line.js";

const FORMATTED_PRICE_LINE_PATTERN = /["'`>](\$|₹|£|€)\s?[\d,]+\.\d{2}["'`<]/;

/**
 * L20-3: can the catalogue itself be located and parsed by code, not
 * just rendered for a human eye. A price stored as a formatted string
 * is a parsing hazard and, in this project's own terms, a float waiting
 * to happen — see CLAUDE.md rule 3.
 *
 * The formatted-price and SKU-field predicates come from
 * shared/store-readiness-checks.ts, the same file the Instant Audit's
 * store-checks.ts imports — see that file's header (L24-11).
 */

const CATALOGUE_CANDIDATES = [
  /products?\.json$/i,
  /\/schema\.prisma$/i,
  /\/schema\.ts$/i, // drizzle
  /shopify.*export.*\.csv$/i,
  /products?\.csv$/i,
];

export function checkMachineReadability(scope: ProjectScope, allFiles: string[]): AuditCheck[] {
  const checks: AuditCheck[] = [];

  const catalogueFiles = allFiles.filter((f) => CATALOGUE_CANDIDATES.some((p) => p.test(f)));
  checks.push({
    id: "catalogue_locatable",
    label: "Product data can be located on disk (export, schema, or products.json)",
    weight: 25,
    passed: catalogueFiles.length > 0,
    fix:
      catalogueFiles.length === 0
        ? { message: "No products.json, CSV export, or ORM schema (Prisma/Drizzle) was found. Without one of these, `thirdman init` can't offer to import your catalogue automatically — see /dashboard/products for the manual paste-a-blob import instead." }
        : undefined,
  });

  let sawFormattedPrice = false;
  let formattedPriceFile: string | undefined;
  let formattedPriceLine: number | undefined;
  for (const f of catalogueFiles) {
    const content = safeRead(scope, f);
    if (content && priceLooksLikeFormattedString(content)) {
      sawFormattedPrice = true;
      formattedPriceFile = f;
      formattedPriceLine = findLineNumber(content, FORMATTED_PRICE_LINE_PATTERN) ?? undefined;
      break;
    }
  }
  checks.push({
    id: "prices_not_formatted_strings",
    label: "Prices are not stored as pre-formatted currency strings",
    weight: 15,
    passed: catalogueFiles.length === 0 || !sawFormattedPrice,
    fix: sawFormattedPrice
      ? {
          message: `Found a price shaped like a formatted currency string (e.g. "₹1,299.00") in ${formattedPriceFile} — this is a parsing hazard for an agent, and in this product's own terms, a float waiting to happen.`,
          file: formattedPriceFile,
          line: formattedPriceLine,
        }
      : undefined,
  });

  let sawSkuField = false;
  for (const f of catalogueFiles) {
    const content = safeRead(scope, f);
    if (content && hasSkuField(content)) {
      sawSkuField = true;
      break;
    }
  }
  checks.push({
    id: "stable_sku_present",
    label: "A stable SKU or id field exists per purchasable variant",
    weight: 15,
    passed: catalogueFiles.length === 0 || sawSkuField,
    fix:
      catalogueFiles.length > 0 && !sawSkuField
        ? { message: "No field that looks like a SKU/product id was found in your catalogue data — an agent has no stable id to reorder or reconcile against." }
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
