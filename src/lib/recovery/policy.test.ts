import { describe, it, expect } from "vitest";
import {
  shouldAttemptRecovery,
  chooseStrategy,
  expectedValuePaise,
  nextAttemptTime,
  MAX_ATTEMPTS_PER_FAILURE,
  MIN_RECOVERABLE_AMOUNT_PAISE,
  HIGH_VALUE_ESCALATION_PAISE,
  MIN_HOURS_BETWEEN_ATTEMPTS,
  type PriorAttempt,
} from "@/lib/recovery/policy";
import { DECLINE_CATEGORIES, type DeclineCategory, type Diagnosis } from "@/lib/recovery/diagnose";

function makeDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    rootCause: "test root cause",
    category: "issuer_declined",
    recoverable: true,
    confidence: "high",
    source: "model",
    ...overrides,
  };
}

const NOW = new Date("2026-01-01T12:00:00Z");

describe("shouldAttemptRecovery — stopping rules", () => {
  it("stops when the failure is already recovered", () => {
    const result = shouldAttemptRecovery(
      { amountPaise: 100000, status: "recovered" },
      makeDiagnosis(),
      [],
      NOW,
    );
    expect(result.proceed).toBe(false);
    expect(result.stoppingRule).toBe("already_resolved");
    expect(result.reason.length).toBeGreaterThan(10);
  });

  it("stops when the failure is already written off", () => {
    const result = shouldAttemptRecovery(
      { amountPaise: 100000, status: "written_off" },
      makeDiagnosis(),
      [],
      NOW,
    );
    expect(result.proceed).toBe(false);
    expect(result.stoppingRule).toBe("already_resolved");
  });

  it("stops when the diagnosis says unrecoverable", () => {
    const result = shouldAttemptRecovery(
      { amountPaise: 100000, status: "diagnosed" },
      makeDiagnosis({ recoverable: false }),
      [],
      NOW,
    );
    expect(result.proceed).toBe(false);
    expect(result.stoppingRule).toBe("unrecoverable_diagnosis");
  });

  it("stops at the attempt ceiling — a 4th attempt is refused", () => {
    const prior: PriorAttempt[] = Array.from({ length: MAX_ATTEMPTS_PER_FAILURE }, (_, i) => ({
      attemptNumber: i + 1,
      outcome: "failed",
      createdAt: NOW,
      nextAttemptAt: null,
    }));

    const result = shouldAttemptRecovery(
      { amountPaise: 100000, status: "recovering" },
      makeDiagnosis(),
      prior,
      NOW,
    );
    expect(result.proceed).toBe(false);
    expect(result.stoppingRule).toBe("max_attempts_reached");
    expect(result.reason).toContain(String(MAX_ATTEMPTS_PER_FAILURE));
  });

  it("does not stop on the ceiling one attempt below it", () => {
    const prior: PriorAttempt[] = Array.from({ length: MAX_ATTEMPTS_PER_FAILURE - 1 }, (_, i) => ({
      attemptNumber: i + 1,
      outcome: "failed",
      createdAt: NOW,
      nextAttemptAt: null,
    }));

    const result = shouldAttemptRecovery(
      { amountPaise: 100000, status: "recovering" },
      makeDiagnosis(),
      prior,
      NOW,
    );
    expect(result.stoppingRule).not.toBe("max_attempts_reached");
  });

  it("holds until the backoff window elapses", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);
    const prior: PriorAttempt[] = [{ attemptNumber: 1, outcome: "failed", createdAt: NOW, nextAttemptAt: future }];

    const before = shouldAttemptRecovery({ amountPaise: 100000, status: "recovering" }, makeDiagnosis(), prior, NOW);
    expect(before.proceed).toBe(false);
    expect(before.stoppingRule).toBe("backoff_window_not_elapsed");

    const after = shouldAttemptRecovery(
      { amountPaise: 100000, status: "recovering" },
      makeDiagnosis(),
      prior,
      new Date(future.getTime() + 1000),
    );
    expect(after.stoppingRule).not.toBe("backoff_window_not_elapsed");
  });

  it("stops below the minimum recoverable amount", () => {
    const result = shouldAttemptRecovery(
      { amountPaise: MIN_RECOVERABLE_AMOUNT_PAISE - 1, status: "diagnosed" },
      makeDiagnosis(),
      [],
      NOW,
    );
    expect(result.proceed).toBe(false);
    expect(result.stoppingRule).toBe("below_minimum_recoverable_amount");
  });

  it("does not stop for amount exactly at the minimum recoverable floor", () => {
    const result = shouldAttemptRecovery(
      { amountPaise: MIN_RECOVERABLE_AMOUNT_PAISE, status: "diagnosed" },
      makeDiagnosis(),
      [],
      NOW,
    );
    expect(result.stoppingRule).not.toBe("below_minimum_recoverable_amount");
  });

  it("the ROI governor refuses a recovery costing more than the allowed ratio", () => {
    // At MIN_RECOVERABLE_AMOUNT_PAISE, a single attempt's flat cost is
    // comfortably inside the ratio, so the ROI rule needs enough prior
    // attempts that the cumulative cost outgrows the ratio before the
    // attempt ceiling does. Above the minimum-recoverable floor, below
    // where 10% of the amount would cover 3 attempts' cost.
    const amountPaise = 5500; // 3 * RECOVERY_COST_PAISE (600) > 10% of 5500 (550)
    const prior: PriorAttempt[] = [
      { attemptNumber: 1, outcome: "failed", createdAt: NOW, nextAttemptAt: null },
      { attemptNumber: 2, outcome: "failed", createdAt: NOW, nextAttemptAt: null },
    ];
    const result = shouldAttemptRecovery({ amountPaise, status: "recovering" }, makeDiagnosis(), prior, NOW);
    expect(result.proceed).toBe(false);
    expect(result.stoppingRule).toBe("roi_governor");
  });

  it("high-value failures always route to a human, never proceed automatically", () => {
    const result = shouldAttemptRecovery(
      { amountPaise: HIGH_VALUE_ESCALATION_PAISE, status: "diagnosed" },
      makeDiagnosis(),
      [],
      NOW,
    );
    expect(result.proceed).toBe(false);
    expect(result.stoppingRule).toBe("high_value_requires_human");
  });

  it("proceeds when every rule is satisfied", () => {
    const result = shouldAttemptRecovery(
      { amountPaise: 100000, status: "diagnosed" },
      makeDiagnosis(),
      [],
      NOW,
    );
    expect(result.proceed).toBe(true);
    expect(result.stoppingRule).toBeUndefined();
  });
});

describe("chooseStrategy — exhaustive over every decline category", () => {
  it("maps every known category to a defined strategy", () => {
    for (const category of DECLINE_CATEGORIES) {
      const strategy = chooseStrategy(category);
      expect(strategy).toBeDefined();
    }
  });

  it("suspected_fraud is never automatic", () => {
    expect(chooseStrategy("suspected_fraud")).toBe("human_escalation");
  });

  it("issuer_declined, expired_card, and invalid_instrument never retry the same instrument", () => {
    const categories: DeclineCategory[] = ["issuer_declined", "expired_card", "invalid_instrument"];
    for (const category of categories) {
      expect(chooseStrategy(category)).toBe("alternate_instrument");
    }
  });

  it("unknown writes off rather than guessing a strategy", () => {
    expect(chooseStrategy("unknown")).toBe("write_off");
  });
});

describe("expectedValuePaise — integer paise arithmetic only", () => {
  it("never returns a non-integer amount, across every category and several attempt numbers", () => {
    for (const category of DECLINE_CATEGORIES) {
      for (const attemptNumber of [1, 2, 3]) {
        const value = expectedValuePaise(123456, category, attemptNumber);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("suspected_fraud and unknown never have positive expected value", () => {
    expect(expectedValuePaise(1000000, "suspected_fraud", 1)).toBe(0);
    expect(expectedValuePaise(1000000, "unknown", 1)).toBe(0);
  });
});

describe("nextAttemptTime — backoff schedule", () => {
  it("strictly increases with each attempt number", () => {
    const t1 = nextAttemptTime(1, NOW).getTime();
    const t2 = nextAttemptTime(2, NOW).getTime();
    const t3 = nextAttemptTime(3, NOW).getTime();
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
  });

  it("matches the documented hour schedule", () => {
    for (let i = 0; i < MIN_HOURS_BETWEEN_ATTEMPTS.length; i++) {
      const expected = NOW.getTime() + MIN_HOURS_BETWEEN_ATTEMPTS[i] * 60 * 60 * 1000;
      expect(nextAttemptTime(i + 1, NOW).getTime()).toBe(expected);
    }
  });

  it("does not go out of bounds for an attempt number beyond the schedule length", () => {
    const result = nextAttemptTime(MIN_HOURS_BETWEEN_ATTEMPTS.length + 5, NOW);
    expect(result.getTime()).toBeGreaterThan(NOW.getTime());
  });
});
