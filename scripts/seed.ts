import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { hashPassword } from "@/lib/password";

/**
 * Idempotent seed data — safe to re-run. This is the catalogue that
 * appears in the demo video, so products are a coherent store, not
 * lorem ipsum. Prices/costs vary enough that margin-aware decisions
 * in later layers (upsell, negotiation) have something real to work with.
 *
 * Agent API keys are randomly generated per environment, never hardcoded.
 * Only the hash is ever written to the database. The raw key is written
 * once to a gitignored local file so re-running this script stays
 * idempotent — a real deployment would instead hand the key to the
 * agent out-of-band at provisioning time and never persist it at all.
 */

const SEED_KEYS_FILE = path.resolve(__dirname, "../.seed-keys.local.json");

const MERCHANT_NAME = "Northside Coffee Supply Co.";
const MERCHANT_EMAIL = "demo@northsidecoffee.test";
const MERCHANT_PASSWORD = "demo-password-123";

const PRODUCTS = [
  { name: "Single-Origin Ethiopia Yirgacheffe (250g)", description: "Light roast, floral and citrus notes. Washed process.", pricePaise: 65000, costPaise: 32000, stock: 40 },
  { name: "House Blend Espresso (500g)", description: "Medium-dark roast, chocolate and caramel. Our best seller.", pricePaise: 85000, costPaise: 38000, stock: 120 },
  { name: "Decaf Colombia Supremo (250g)", description: "Swiss water process, medium roast.", pricePaise: 70000, costPaise: 41000, stock: 25 },
  { name: "Cold Brew Concentrate (1L)", description: "Ready to dilute, steeped 18 hours.", pricePaise: 45000, costPaise: 19000, stock: 60 },
  { name: "V60 Pour-Over Dripper", description: "Ceramic, size 02. Made in Japan.", pricePaise: 180000, costPaise: 95000, stock: 15 },
  { name: "Burr Grinder — Manual", description: "Stainless steel conical burrs, 18 click settings.", pricePaise: 320000, costPaise: 210000, stock: 10 },
  { name: "Espresso Machine — Semi-Automatic", description: "15-bar pump, milk frother wand.", pricePaise: 1250000, costPaise: 890000, stock: 4 },
  { name: "Filter Papers (100 pack)", description: "Unbleached, fits V60-02.", pricePaise: 25000, costPaise: 9000, stock: 200 },
  { name: "Reusable Steel Filter", description: "Fine mesh, fits V60-02. Zero waste.", pricePaise: 95000, costPaise: 48000, stock: 30 },
  { name: "Milk Frothing Pitcher (600ml)", description: "Stainless steel, precision spout.", pricePaise: 110000, costPaise: 62000, stock: 22 },
  { name: "Brazil Cerrado (1kg, wholesale)", description: "Bulk bag for cafes. Medium roast.", pricePaise: 220000, costPaise: 140000, stock: 18 },
  { name: "Guatemala Huehuetenango (250g)", description: "Medium roast, notes of dark chocolate and spice.", pricePaise: 68000, costPaise: 33000, stock: 35 },
  { name: "Coffee Subscription — Monthly (250g)", description: "One curated bag delivered monthly. Cancel anytime.", pricePaise: 60000, costPaise: 30000, stock: 999 },
  { name: "Digital Coffee Scale", description: "0.1g precision, built-in timer.", pricePaise: 250000, costPaise: 130000, stock: 20 },
  { name: "Insulated Travel Mug (350ml)", description: "Vacuum sealed, leakproof lid.", pricePaise: 140000, costPaise: 72000, stock: 50 },
];

const AGENT_DEFS = [
  { key: "active_agent", name: "Demo Shopping Agent (active)", status: "active" as const },
  { key: "revoked_agent", name: "Demo Shopping Agent (revoked)", status: "revoked" as const },
];

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function generateRawKey(): string {
  return `sk_${randomBytes(24).toString("base64url")}`;
}

/**
 * Loads previously generated raw keys from the local seed-keys file, or
 * generates and persists new ones. Reusing the same raw key across runs
 * is what keeps the seed idempotent — each agent is looked up by the
 * hash of its own key, so a fresh random key on every run would create
 * a new agent row every time instead of recognizing the existing one.
 */
function loadOrCreateRawKeys(): Record<string, string> {
  let stored: Record<string, string> = {};
  if (existsSync(SEED_KEYS_FILE)) {
    stored = JSON.parse(readFileSync(SEED_KEYS_FILE, "utf8"));
  }

  let changed = false;
  for (const def of AGENT_DEFS) {
    if (!stored[def.key]) {
      stored[def.key] = generateRawKey();
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(SEED_KEYS_FILE, JSON.stringify(stored, null, 2));
  }

  return stored;
}

async function main() {
  let merchant = (
    await db.select().from(schema.merchants).where(eq(schema.merchants.name, MERCHANT_NAME))
  )[0];

  if (!merchant) {
    const passwordHash = await hashPassword(MERCHANT_PASSWORD);
    [merchant] = await db
      .insert(schema.merchants)
      .values({ name: MERCHANT_NAME, email: MERCHANT_EMAIL, passwordHash })
      .returning();
    console.log("Created merchant:", merchant.name, merchant.id);
    console.log(`  Login at /login with ${MERCHANT_EMAIL} / ${MERCHANT_PASSWORD} (dev only, never a real credential).`);
  } else if (merchant.passwordHash.startsWith("locked:")) {
    // A pre-Layer-2 merchant row, backfilled by the migration with a
    // login-blocking placeholder hash. Give it real dev credentials so
    // seeding stays usable without a manual signup.
    const passwordHash = await hashPassword(MERCHANT_PASSWORD);
    [merchant] = await db
      .update(schema.merchants)
      .set({ email: MERCHANT_EMAIL, passwordHash })
      .where(eq(schema.merchants.id, merchant.id))
      .returning();
    console.log("Backfilled login credentials for existing merchant:", merchant.name, merchant.id);
    console.log(`  Login at /login with ${MERCHANT_EMAIL} / ${MERCHANT_PASSWORD} (dev only, never a real credential).`);
  } else {
    console.log("Merchant already exists:", merchant.name, merchant.id);
  }

  const existingProducts = await db
    .select({ name: schema.products.name })
    .from(schema.products)
    .where(eq(schema.products.merchantId, merchant.id));
  const existingNames = new Set(existingProducts.map((p) => p.name));

  const productsToInsert = PRODUCTS.filter((p) => !existingNames.has(p.name)).map((p) => ({
    ...p,
    merchantId: merchant.id,
  }));

  if (productsToInsert.length > 0) {
    await db.insert(schema.products).values(productsToInsert);
    console.log(`Inserted ${productsToInsert.length} new product(s).`);
  } else {
    console.log("All products already seeded.");
  }

  const rawKeys = loadOrCreateRawKeys();

  for (const agentDef of AGENT_DEFS) {
    const rawKey = rawKeys[agentDef.key];
    const apiKeyHash = hashKey(rawKey);
    const existing = (
      await db.select().from(schema.agents).where(eq(schema.agents.apiKeyHash, apiKeyHash))
    )[0];

    if (existing) {
      console.log("Agent already exists:", agentDef.name, existing.id);
      continue;
    }

    const [agent] = await db
      .insert(schema.agents)
      .values({
        merchantId: merchant.id,
        name: agentDef.name,
        apiKeyHash,
        status: agentDef.status,
      })
      .returning();
    console.log("Created agent:", agent.name, agent.id);
  }

  console.log(
    `\nRaw agent keys for local testing are in ${path.relative(process.cwd(), SEED_KEYS_FILE)} (gitignored, never committed).`,
  );

  const finalProductCount = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.merchantId, merchant.id));
  const finalAgentCount = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.merchantId, merchant.id));

  console.log(
    `\nSeed complete. Merchant "${merchant.name}" has ${finalProductCount.length} products and ${finalAgentCount.length} agents.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed FAILED:", err);
    process.exit(1);
  });
