import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // agent-buyer/ is a standalone package (Layer 19) with its own
    // package.json, tsconfig.json, and lint/test setup — outside this
    // app's Next.js build by design (plans/layer-19-adversarial-buyer.md).
    "agent-buyer/**",
  ]),
  {
    // Only src/lib/env.ts may read process.env directly — everywhere
    // else must import the validated `env` object from there.
    files: ["**/*.{ts,tsx}"],
    ignores: ["src/lib/env.ts", "drizzle.config.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Import `env` from '@/lib/env' instead of reading process.env directly.",
        },
      ],
    },
  },
]);

export default eslintConfig;
