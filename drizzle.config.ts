import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside the app's module graph, so it reads
// process.env directly rather than importing the validated src/lib/env.
// This is the one sanctioned exception — see src/lib/env.ts.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run drizzle-kit commands.");
}

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
});
