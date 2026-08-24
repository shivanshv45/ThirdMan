import { assessRisk } from "@/lib/risk";

async function main() {
  console.log("Case 1: small, unremarkable purchase, should allow");
  const normal = await assessRisk(
    { fractionOfCap: 0.05, recentRequestCount: 1, isRepeatedAmount: false },
    "one bag of Ethiopia Yirgacheffe coffee",
  );
  console.log(normal);

  console.log("\nCase 2: consumes almost the whole cap in one shot, should escalate");
  const suspicious = await assessRisk(
    { fractionOfCap: 0.95, recentRequestCount: 8, isRepeatedAmount: true },
    "espresso machine, repeated identical purchase attempted 8 times in 5 minutes",
  );
  console.log(suspicious);

  if (normal.decision !== "allow") {
    throw new Error(`Expected the normal case to allow, got ${normal.decision}`);
  }
  if (suspicious.decision !== "escalate") {
    throw new Error(`Expected the suspicious case to escalate, got ${suspicious.decision}`);
  }

  console.log("\nRisk assessment check PASSED.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
