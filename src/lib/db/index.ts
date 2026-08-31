import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

// Lazy, same reasoning as src/lib/env.ts's own proxy and src/lib/llm.ts's
// lazy provider clients: this module is imported by nearly every route in
// the app, so a real DATABASE_URL had to exist just to statically collect
// page data during a build — including a build stage (Cloud Run/
// Buildpacks) that legitimately has no runtime secrets yet. The
// connection is created on first real query instead, and everything
// downstream keeps calling db.select()/db.insert()/etc. exactly as before.
let _db: Db | undefined;
function resolveDb(): Db {
  if (!_db) {
    const client = postgres(env.DATABASE_URL, { ssl: "require" });
    _db = drizzle(client, { schema });
  }
  return _db;
}

export const db = new Proxy({} as Db, {
  get(_target, prop: string | symbol) {
    return Reflect.get(resolveDb() as object, prop);
  },
});
export { schema };
