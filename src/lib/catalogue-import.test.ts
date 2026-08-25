import { describe, it, expect, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { parseCsv, importCatalogueRows, type ImportRowPreview } from "@/lib/catalogue-import";

/**
 * L5-2: catalogue import. parseCsv is pure/no I/O, tested directly.
 * importCatalogueRows hits the real DB — no mocks, same standard as the
 * rest of this codebase. What's under test: CSV parsing is deterministic
 * (never sent to a model), a malformed row produces a per-row error
 * rather than a partial or corrupted write, and re-importing the same
 * SKU updates rather than duplicates.
 */

const createdMerchantIds: string[] = [];

afterEach(async () => {
  for (const merchantId of createdMerchantIds) {
    const products = await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.merchantId, merchantId));
    const productIds = products.map((p) => p.id);
    if (productIds.length > 0) {
      await db.delete(schema.productVariants).where(inArray(schema.productVariants.productId, productIds));
      await db.delete(schema.products).where(inArray(schema.products.id, productIds));
    }
    await db.delete(schema.auditLog).where(eq(schema.auditLog.merchantId, merchantId));
    await db.delete(schema.catalogueImports).where(eq(schema.catalogueImports.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  }
  createdMerchantIds.length = 0;
});

describe("parseCsv — deterministic, no model involved", () => {
  it("maps aliased column headers and parses valid rows", () => {
    const csv = `Product Name,SKU,Price (INR),Cost,Stock\nEspresso Blend,ESP-1,850.00,400,20\n`;
    const preview = parseCsv(csv);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({ name: "Espresso Blend", sku: "ESP-1", priceRupees: 850, costRupees: 400, stock: 20, error: null });
  });

  it("strips a UTF-8 BOM from the first header", () => {
    const csv = "﻿name,sku,price,stock\nMug,MUG-1,300,5\n";
    const preview = parseCsv(csv);
    expect(preview.rows[0].error).toBeNull();
    expect(preview.rows[0].name).toBe("Mug");
  });

  it("a missing required field produces a per-row error, not a thrown exception", () => {
    const csv = `name,sku,price,stock\n,SKU-1,100,5\nValid,SKU-2,100,5\n`;
    const preview = parseCsv(csv);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0].error).toMatch(/name/i);
    expect(preview.rows[1].error).toBeNull();
  });

  it("an unparseable price produces a per-row error", () => {
    const csv = `name,sku,price,stock\nWidget,SKU-1,not-a-price,5\n`;
    const preview = parseCsv(csv);
    expect(preview.rows[0].error).toMatch(/price/i);
  });

  it("a duplicate SKU within the same file is flagged on the second occurrence", () => {
    const csv = `name,sku,price,stock\nA,SKU-1,100,5\nB,SKU-1,200,3\n`;
    const preview = parseCsv(csv);
    expect(preview.rows[0].error).toBeNull();
    expect(preview.rows[1].error).toMatch(/duplicate/i);
  });

  it("an unmapped column is surfaced, not silently dropped", () => {
    const csv = `name,sku,price,stock,warehouse_notes\nA,SKU-1,100,5,fragile\n`;
    const preview = parseCsv(csv);
    expect(preview.unmappedColumns).toContain("warehouse_notes");
  });
});

describe("importCatalogueRows — the only writer, idempotent by SKU", () => {
  it("writes only rows without an error — a row with an error is skipped, not force-written", async () => {
    const merchant = await createTestMerchant("__import_test_skip__");
    createdMerchantIds.push(merchant.id);

    const rows: ImportRowPreview[] = [
      { name: "Good Product", description: "", sku: "GOOD-1", priceRupees: 100, costRupees: 40, stock: 5, error: null },
      { name: "", description: "", sku: "BAD-1", priceRupees: 100, costRupees: 40, stock: 5, error: "Missing name" },
    ];

    const result = await importCatalogueRows(merchant.id, "csv", rows);
    expect(result.rowsImported).toBe(1);
    expect(result.rowsSkipped).toBe(1);

    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.merchantId, merchant.id));
    expect(variants).toHaveLength(1);
    expect(variants[0].sku).toBe("GOOD-1");
  });

  it("re-importing the same SKU updates the existing variant instead of creating a duplicate", async () => {
    const merchant = await createTestMerchant("__import_test_idempotent__");
    createdMerchantIds.push(merchant.id);

    const firstRows: ImportRowPreview[] = [
      { name: "Coffee Bag", description: "v1", sku: "IDEMP-1", priceRupees: 500, costRupees: 200, stock: 10, error: null },
    ];
    await importCatalogueRows(merchant.id, "csv", firstRows);

    const secondRows: ImportRowPreview[] = [
      { name: "Coffee Bag", description: "v2, updated", sku: "IDEMP-1", priceRupees: 550, costRupees: 220, stock: 8, error: null },
    ];
    const result = await importCatalogueRows(merchant.id, "csv", secondRows);
    expect(result.rowsImported).toBe(1);

    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.merchantId, merchant.id));
    expect(variants).toHaveLength(1); // not 2 — the same SKU updated in place
    expect(variants[0].pricePaise).toBe(55_000);
    expect(variants[0].stock).toBe(8);
  });

  it("writes exactly one catalogue_imports row summarizing counts, not one row per imported product", async () => {
    const merchant = await createTestMerchant("__import_test_summary__");
    createdMerchantIds.push(merchant.id);

    const rows: ImportRowPreview[] = [
      { name: "A", description: "", sku: "SUM-A", priceRupees: 100, costRupees: 0, stock: 1, error: null },
      { name: "B", description: "", sku: "SUM-B", priceRupees: 100, costRupees: 0, stock: 1, error: null },
    ];
    await importCatalogueRows(merchant.id, "csv", rows);

    const imports = await db.select().from(schema.catalogueImports).where(eq(schema.catalogueImports.merchantId, merchant.id));
    expect(imports).toHaveLength(1);
    expect(imports[0].rowsImported).toBe(2);
  });
});
