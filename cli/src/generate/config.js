import { generatedByField } from "./headers.js";
/** L20-5: thirdman.config.json — merchant id, the PUBLISHABLE embed key, and the origin. Never a secret: the agent API key goes only to .env.local, checked by the governing rule in secrets.ts. */
export function generateConfig(config) {
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
//# sourceMappingURL=config.js.map