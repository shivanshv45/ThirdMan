import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { generateApiKey, hashApiKey } from "@/lib/agent-auth";
import { setSpendCap } from "@/lib/dashboard-mutations";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Layer 19: provisions the real, persistent scenario the standalone
 * agent-buyer/ package runs against — a real agent row, a real spend
 * cap, real capability grants, and a real seeded catalogue tuned so the
 * buyer's goal is NOT satisfiable by the naive path (see
 * plans/layer-19-adversarial-buyer.md's L19-3). Idempotent, matching
 * scripts/seed.ts's own discipline — safe to re-run, never duplicates.
 *
 * Unlike the ephemeral scripts/demo-failure-*.ts scripts, this state is
 * meant to persist between runs of the buyer agent (a live demo needs a
 * stable SKU and agent key to point THIRDMAN_AGENT_KEY at), so there is
 * no cleanup step here — see scripts/reset-buyer-agent.ts to tear it
 * down.
 */

const SEED_KEYS_FILE = path.resolve(__dirname, "../.seed-keys.local.json");
const AGENT_NAME = "Buyer Agent (Layer 19, external)";
const AGENT_KEY_NAME = "buyer_agent";

const NEGOTIABLE_SKU = "buyer-demo-espresso-250g";
const OUT_OF_STOCK_SKU = "buyer-demo-limited-roast-250g";

/**
 * Tuning: list price ₹900/unit. The goal below asks for 3 units under a
 * ₹2000 total cap. 3 * 900 = ₹2700 — over cap, so the naive purchase is
 * refused (spend_cap_balance). The floor is ₹700/unit — negotiating
 * down to or below ₹666.67/unit average makes 3 units affordable, so a
 * real negotiated purchase can complete within the same cap. This is
 * real tuning, not a special code path: negotiation.ts's own floor
 * arithmetic and gate.ts's own cap arithmetic are what make this work.
 */
const NEGOTIABLE_PRICE_PAISE = 90_000;
const NEGOTIABLE_FLOOR_PAISE = 70_000;
const CAP_PAISE = 200_000;
const PER_TRANSACTION_MAX_PAISE = 200_000;

function loadOrCreateRawKey(): string {
  let stored: Record<string, string> = {};
  if (existsSync(SEED_KEYS_FILE)) {
    stored = JSON.parse(readFileSync(SEED_KEYS_FILE, "utf8"));
  }
  if (!stored[AGENT_KEY_NAME]) {
    stored[AGENT_KEY_NAME] = generateApiKey();
    writeFileSync(SEED_KEYS_FILE, JSON.stringify(stored, null, 2));
  }
  return stored[AGENT_KEY_NAME];
}

async function main() {
  const [merchant] = await db.select().from(schema.merchants).orderBy(schema.merchants.createdAt).limit(1);
  if (!merchant) throw new Error("No merchant found. Run `npm run script scripts/seed.ts` first.");

  const rawKey = loadOrCreateRawKey();
  const apiKeyHash = hashApiKey(rawKey);

  let [agent] = await db.select().from(schema.agents).where(eq(schema.agents.apiKeyHash, apiKeyHash));
  if (!agent) {
    [agent] = await db.insert(schema.agents).values({ merchantId: merchant.id, name: AGENT_NAME, apiKeyHash, status: "active" }).returning();
    console.log(`Created agent "${agent.name}" (${agent.id}).`);
  } else {
    console.log(`Agent already exists: "${agent.name}" (${agent.id}).`);
  }

  await setSpendCap({
    merchantId: merchant.id,
    agentId: agent.id,
    capRupees: CAP_PAISE / 100,
    perTransactionMaxRupees: PER_TRANSACTION_MAX_PAISE / 100,
    windowHours: 24,
  });
  console.log(`Spend cap set: ₹${CAP_PAISE / 100} total, ₹${PER_TRANSACTION_MAX_PAISE / 100} per transaction.`);

  // Deliberately withheld: rewards:read/redeem, offers:read — an
  // untuned capability gap the buyer will genuinely hit if the model
  // tries get_offers or get_reward_balance, exercising the real
  // deny-by-default capability check (Layer 13-2) rather than a staged
  // one. products:read/policy:read/negotiation:create/purchase:create
  // are what a real shopping+buying flow needs.
  await db.delete(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agent.id));
  await db.insert(schema.agentCapabilities).values(
    (["products:read", "policy:read", "negotiation:create", "purchase:create"] as const).map((capability) => ({
      agentId: agent.id,
      capability,
    })),
  );
  console.log("Capabilities set: products:read, policy:read, negotiation:create, purchase:create.");

  const [negotiableProduct] = await ensureProduct(merchant.id, "Buyer Demo — Negotiable Espresso (250g)", "A negotiable espresso bag seeded for the Layer 19 buyer-agent scenario.");
  await ensureVariant(negotiableProduct.id, merchant.id, NEGOTIABLE_SKU, NEGOTIABLE_PRICE_PAISE, 50_000, 40, NEGOTIABLE_FLOOR_PAISE);

  const [outOfStockProduct] = await ensureProduct(merchant.id, "Buyer Demo — Limited Roast (250g), out of stock", "An out-of-stock variant seeded so the buyer genuinely hits the stock-check refusal.");
  await ensureVariant(outOfStockProduct.id, merchant.id, OUT_OF_STOCK_SKU, 95_000, 55_000, 0, null, "out_of_stock");

  console.log(`\nagent-buyer/.env.local should point at:\n  THIRDMAN_AGENT_KEY=${rawKey}\n  (never committed — see .seed-keys.local.json, gitignored)`);
  console.log(`\nSeeded SKUs: "${NEGOTIABLE_SKU}" (₹${NEGOTIABLE_PRICE_PAISE / 100} list, ₹${NEGOTIABLE_FLOOR_PAISE / 100} floor, in stock), "${OUT_OF_STOCK_SKU}" (out of stock).`);
}

async function ensureProduct(merchantId: string, name: string, description: string) {
  const existing = await db.select().from(schema.products).where(eq(schema.products.name, name));
  if (existing.length > 0) return existing;
  return db.insert(schema.products).values({ merchantId, name, description, status: "active" }).returning();
}

async function ensureVariant(
  productId: string,
  merchantId: string,
  sku: string,
  pricePaise: number,
  costPaise: number,
  stock: number,
  floorPricePaise: number | null,
  availability: (typeof schema.variantAvailabilityEnum.enumValues)[number] = "in_stock",
) {
  const [existing] = await db.select().from(schema.productVariants).where(eq(schema.productVariants.sku, sku));
  if (existing) {
    await db
      .update(schema.productVariants)
      .set({ pricePaise, costPaise, stock, floorPricePaise, availability, status: "active" })
      .where(eq(schema.productVariants.id, existing.id));
    return existing;
  }
  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId, merchantId, sku, pricePaise, costPaise, stock, floorPricePaise, availability, status: "active" })
    .returning();
  return variant;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Buyer-agent seed FAILED:", err);
    process.exit(1);
  });
