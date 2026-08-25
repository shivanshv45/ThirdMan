import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logAuditEntry } from "@/lib/audit";
import { completeStructured } from "@/lib/llm";
import { rupeesToPaise } from "@/lib/money";

/**
 * Catalogue import (Layer 5-2): CSV upload (parsed deterministically in
 * code — never sent to a model, since a model silently dropping a row is
 * a data-integrity bug nobody would notice) and paste-a-blob (an LLM
 * extracts structure from unstructured text, e.g. a supplier email).
 *
 * The rule that makes both safe: nothing either path produces is written
 * to the database until the merchant confirms a preview. Extraction
 * proposes; the merchant's confirm click writes. Same principle as
 * chat.ts's applyIntent, and it matters more here — a hallucinated price
 * is a mispriced product the gate will happily honour, since the gate
 * enforces that the caller pays the catalogue price, not that the
 * catalogue price is sane. See DECISIONS.md.
 */

export const MAX_IMPORT_ROWS = 500;
export const MAX_PASTE_TEXT_LENGTH = 20_000;

export interface ImportRowInput {
  name: string;
  description: string;
  sku: string;
  priceRupees: number;
  costRupees: number;
  stock: number;
}

export interface ImportRowPreview extends ImportRowInput {
  /** null when the row parsed cleanly. A non-null error means this row will be skipped, not silently dropped. */
  error: string | null;
}

export interface ImportPreview {
  rows: ImportRowPreview[];
  /** Column headers that appeared in the file but weren't mapped to a known field — surfaced to the merchant rather than silently ignored. */
  unmappedColumns: string[];
}

// A small set of aliases per field — a merchant's CSV export rarely uses
// this project's exact column names.
const COLUMN_ALIASES: Record<keyof ImportRowInput, string[]> = {
  name: ["name", "product name", "title"],
  description: ["description", "desc"],
  sku: ["sku", "product sku", "item sku"],
  priceRupees: ["price", "price (inr)", "price (rs)", "unit price", "price rupees", "priceinr"],
  costRupees: ["cost", "cost (inr)", "unit cost", "cost rupees"],
  stock: ["stock", "quantity", "qty", "inventory"],
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase();
}

/** Splits a single CSV line respecting double-quoted fields (so a quoted comma or embedded quote doesn't break column alignment). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseIntField(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Parses a CSV file's raw text deterministically — no LLM involved. Maps
 * headers by name (via COLUMN_ALIASES), validates each row independently
 * so one bad row doesn't sink the whole file, and reports duplicate SKUs
 * within the file itself (a second, separate step handles SKUs that
 * collide with what's already in the database — see importCatalogueRows).
 */
export function parseCsv(rawText: string): ImportPreview {
  // Strip a UTF-8 BOM, which some spreadsheet exports (Excel) prepend and
  // which would otherwise corrupt the first header's name.
  const text = rawText.replace(/^﻿/, "");
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: [], unmappedColumns: [] };

  const headerCells = splitCsvLine(lines[0]).map(normalizeHeader);
  const fieldByColumnIndex = new Map<number, keyof ImportRowInput>();
  const unmappedColumns: string[] = [];

  headerCells.forEach((cell, idx) => {
    const field = (Object.keys(COLUMN_ALIASES) as (keyof ImportRowInput)[]).find((f) =>
      COLUMN_ALIASES[f].includes(cell),
    );
    if (field) {
      fieldByColumnIndex.set(idx, field);
    } else if (cell.length > 0) {
      unmappedColumns.push(headerCells[idx]);
    }
  });

  const dataLines = lines.slice(1).slice(0, MAX_IMPORT_ROWS);
  const seenSkusInFile = new Set<string>();

  const rows: ImportRowPreview[] = dataLines.map((line) => {
    const cells = splitCsvLine(line);
    const raw: Record<string, string> = {};
    fieldByColumnIndex.forEach((field, idx) => {
      raw[field] = cells[idx] ?? "";
    });

    const name = (raw.name ?? "").trim();
    const description = (raw.description ?? "").trim();
    const sku = (raw.sku ?? "").trim();
    const priceRupees = raw.priceRupees !== undefined ? parseMoney(raw.priceRupees) : null;
    const costRupees = raw.costRupees !== undefined ? parseMoney(raw.costRupees) : 0;
    const stock = raw.stock !== undefined ? parseIntField(raw.stock) : null;

    let error: string | null = null;
    if (!name) error = "Missing name";
    else if (!sku) error = "Missing SKU";
    else if (priceRupees === null) error = "Price is missing or not a valid amount";
    else if (stock === null) error = "Stock is missing or not a non-negative integer";
    else if (seenSkusInFile.has(sku)) error = "Duplicate SKU within this file";

    if (!error && sku) seenSkusInFile.add(sku);

    return {
      name,
      description,
      sku,
      priceRupees: priceRupees ?? 0,
      costRupees: costRupees ?? 0,
      stock: stock ?? 0,
      error,
    };
  });

  return { rows, unmappedColumns };
}

const extractedRowSchema = z.object({
  name: z.string(),
  description: z.string(),
  sku: z.string(),
  priceRupees: z.number().nonnegative(),
  costRupees: z.number().nonnegative(),
  stock: z.number().int().nonnegative(),
});

const extractionResultSchema = z.object({
  rows: z.array(extractedRowSchema),
});

/**
 * Extracts structured rows from a merchant-pasted blob of unstructured
 * text (a website copy-paste, a supplier email, a WhatsApp message) via
 * the model. Nothing here writes to the database — the result is a
 * preview the merchant must confirm, same as parseCsv's output. A model
 * failure surfaces as a thrown error rather than a silently empty or
 * guessed result, since there's no deterministic fallback for free text.
 */
export async function extractFromPastedText(pastedText: string): Promise<ImportPreview> {
  if (pastedText.length > MAX_PASTE_TEXT_LENGTH) {
    throw new Error(`Pasted text is too long (${pastedText.length} characters, max ${MAX_PASTE_TEXT_LENGTH}).`);
  }

  const { data } = await completeStructured({
    prompt: `A merchant pasted this text describing products they sell. Extract each distinct product as a row with: name, a short description, a SKU (invent a short uppercase one like "ABC-123" if none is given — never leave it blank), price in rupees (as a plain number, e.g. 1299.00 for ₹1,299 — never paise), cost in rupees (0 if not mentioned), and stock quantity (a reasonable guess like 10 if not mentioned, never fabricate a suspiciously large number).\n\nText:\n${pastedText}\n\nIf nothing resembling a product list is found, return an empty rows array — do not invent products.`,
    schema: extractionResultSchema,
    schemaDescription: '{ "rows": [{ "name": string, "description": string, "sku": string, "priceRupees": number, "costRupees": number, "stock": number }] }',
  });

  const seenSkusInFile = new Set<string>();
  const rows: ImportRowPreview[] = data.rows.slice(0, MAX_IMPORT_ROWS).map((r) => {
    const sku = r.sku.trim();
    let error: string | null = null;
    if (!r.name.trim()) error = "Missing name";
    else if (!sku) error = "Missing SKU";
    else if (seenSkusInFile.has(sku)) error = "Duplicate SKU within this extraction";

    if (!error) seenSkusInFile.add(sku);

    return {
      name: r.name.trim(),
      description: r.description.trim(),
      sku,
      priceRupees: r.priceRupees,
      costRupees: r.costRupees,
      stock: r.stock,
      error,
    };
  });

  return { rows, unmappedColumns: [] };
}

export interface ImportResult {
  importId: string;
  rowsParsed: number;
  rowsImported: number;
  rowsSkipped: number;
}

/**
 * Writes a confirmed set of rows to the catalogue — the only function in
 * this module that touches products/product_variants. Idempotent by SKU:
 * a SKU matching an existing variant for this merchant updates that
 * variant's product/price/cost/stock rather than creating a duplicate, so
 * re-importing the same file (or a corrected one) doesn't multiply rows.
 * A row still carrying a parse error (from the preview) is skipped, never
 * force-written.
 */
export async function importCatalogueRows(
  merchantId: string,
  source: (typeof schema.catalogueImportSourceEnum.enumValues)[number],
  rows: ImportRowPreview[],
): Promise<ImportResult> {
  const validRows = rows.filter((r) => !r.error);
  let imported = 0;

  for (const row of validRows) {
    const [existingVariant] = await db
      .select()
      .from(schema.productVariants)
      .where(and(eq(schema.productVariants.merchantId, merchantId), eq(schema.productVariants.sku, row.sku)));

    if (existingVariant) {
      await db
        .update(schema.products)
        .set({ name: row.name, description: row.description })
        .where(eq(schema.products.id, existingVariant.productId));
      await db
        .update(schema.productVariants)
        .set({
          pricePaise: rupeesToPaise(row.priceRupees),
          costPaise: rupeesToPaise(row.costRupees),
          stock: row.stock,
          availability: row.stock > 0 ? "in_stock" : "out_of_stock",
        })
        .where(eq(schema.productVariants.id, existingVariant.id));
    } else {
      const [product] = await db
        .insert(schema.products)
        .values({ merchantId, name: row.name, description: row.description, status: "active" })
        .returning();
      await db.insert(schema.productVariants).values({
        productId: product.id,
        merchantId,
        sku: row.sku,
        pricePaise: rupeesToPaise(row.priceRupees),
        costPaise: rupeesToPaise(row.costRupees),
        stock: row.stock,
        availability: row.stock > 0 ? "in_stock" : "out_of_stock",
        status: "active",
      });
    }
    imported++;
  }

  const [importRow] = await db
    .insert(schema.catalogueImports)
    .values({
      merchantId,
      source,
      status: "imported",
      rowsParsed: rows.length,
      rowsImported: imported,
      rowsSkipped: rows.length - imported,
    })
    .returning();

  await logAuditEntry({
    merchantId,
    actor: "merchant",
    event: "catalogue_imported",
    decision: "n/a",
    reason: `Merchant imported a catalogue from ${source === "csv" ? "a CSV file" : "pasted text"}: ${imported} of ${rows.length} rows written, ${rows.length - imported} skipped.`,
  });

  return { importId: importRow.id, rowsParsed: rows.length, rowsImported: imported, rowsSkipped: rows.length - imported };
}

export async function getImportHistory(merchantId: string) {
  return db
    .select()
    .from(schema.catalogueImports)
    .where(eq(schema.catalogueImports.merchantId, merchantId))
    .orderBy(schema.catalogueImports.createdAt);
}
