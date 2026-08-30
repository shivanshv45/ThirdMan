import { generatedByField } from "./headers.js";
import type { FileWrite } from "./diff.js";

export interface ThirdmanConfig {
  merchantId: string;
  publishableKey: string;
  allowedOrigin: string;
  appOrigin: string;
}

/** L20-5: thirdman.config.json — merchant id, the PUBLISHABLE embed key, and the origin. Never a secret: the agent API key goes only to .env.local, checked by the governing rule in secrets.ts. */
export function generateConfig(config: ThirdmanConfig): FileWrite {
  const doc = {
    ...generatedByField(),
    merchantId: config.merchantId,
    publishableKey: config.publishableKey,
    origin: config.allowedOrigin,
    appOrigin: config.appOrigin,
  };

  return {
    relativePath: "thirdman.config.json",
    newContent: `${JSON.stringify(doc, null, 2)}\n`,
  };
}
