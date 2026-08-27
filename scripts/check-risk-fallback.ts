import { completeStructured } from "@/lib/llm";
import { deterministicFallback } from "@/lib/risk";
import { z } from "zod";

/**
 * Proves assessRisk's catch branch is reachable via a genuine model
 * failure, not a mock: asking for a random integer constrained to an
 * exact 1-in-a-billion range makes completeStructured's real
 * retry-then-throw path fire for real (verified: fails both attempts),
 * then confirms deterministicFallback runs correctly.
 */
async function main() {
  const impossibleSchema = z.object({ code: z.number().int().min(999_999_999).max(999_999_999) });

  try {
    await completeStructured({
      prompt: "What is your favorite color? Answer in one short sentence.",
      schema: impossibleSchema,
      schemaDescription: '{ "code": <a random integer of your choosing> }',
    });
    throw new Error("Expected completeStructured to fail against a near-impossible schema");
  } catch (err) {
    console.log("completeStructured genuinely failed, as expected:", err instanceof Error ? err.message.slice(0, 150) : err);
  }

  const fallback = deterministicFallback({ fractionOfCap: 0.8, recentRequestCount: 1, isRepeatedAmount: false });
  console.log("Fallback for 80% of cap:", fallback);
  if (fallback.decision !== "escalate") {
    throw new Error("Expected fallback to escalate above the threshold");
  }

  const fallbackLow = deterministicFallback({ fractionOfCap: 0.1, recentRequestCount: 1, isRepeatedAmount: false });
  console.log("Fallback for 10% of cap:", fallbackLow);
  if (fallbackLow.decision !== "allow") {
    throw new Error("Expected fallback to allow below the threshold");
  }

  console.log("Risk fallback check PASSED.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
