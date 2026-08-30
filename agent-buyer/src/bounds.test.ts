import { describe, it, expect } from "vitest";
import { checkCeilings, DEFAULT_RUN_BOUNDS, type RunBounds } from "./bounds";

const bounds: RunBounds = DEFAULT_RUN_BOUNDS;

describe("checkCeilings", () => {
  it("allows a fresh run to proceed", () => {
    const outcome = checkCeilings(bounds, { stepCount: 0, purchaseAttempts: 0, startedAtMs: 0, nowMs: 0 });
    expect(outcome).toBeNull();
  });

  it("ends the run as exhausted once the step ceiling is reached", () => {
    const outcome = checkCeilings(bounds, { stepCount: bounds.maxSteps, purchaseAttempts: 0, startedAtMs: 0, nowMs: 0 });
    expect(outcome).toBe("exhausted");
  });

  it("does not trip on the step just below the ceiling", () => {
    const outcome = checkCeilings(bounds, { stepCount: bounds.maxSteps - 1, purchaseAttempts: 0, startedAtMs: 0, nowMs: 0 });
    expect(outcome).toBeNull();
  });

  it("ends the run as exhausted once purchase attempts exceed the ceiling", () => {
    const outcome = checkCeilings(bounds, {
      stepCount: 0,
      purchaseAttempts: bounds.maxPurchaseAttempts + 1,
      startedAtMs: 0,
      nowMs: 0,
    });
    expect(outcome).toBe("exhausted");
  });

  it("allows exactly maxPurchaseAttempts purchases", () => {
    const outcome = checkCeilings(bounds, {
      stepCount: 0,
      purchaseAttempts: bounds.maxPurchaseAttempts,
      startedAtMs: 0,
      nowMs: 0,
    });
    expect(outcome).toBeNull();
  });

  it("ends the run as timed_out once wall-clock budget is exceeded", () => {
    const outcome = checkCeilings(bounds, {
      stepCount: 0,
      purchaseAttempts: 0,
      startedAtMs: 0,
      nowMs: bounds.maxRunMillis + 1,
    });
    expect(outcome).toBe("timed_out");
  });

  it("does not trip on wall-clock time exactly at the budget", () => {
    const outcome = checkCeilings(bounds, {
      stepCount: 0,
      purchaseAttempts: 0,
      startedAtMs: 0,
      nowMs: bounds.maxRunMillis,
    });
    expect(outcome).toBeNull();
  });

  it("timeout takes priority when both step and time ceilings are exceeded", () => {
    const outcome = checkCeilings(bounds, {
      stepCount: bounds.maxSteps,
      purchaseAttempts: 0,
      startedAtMs: 0,
      nowMs: bounds.maxRunMillis + 1,
    });
    expect(outcome).toBe("timed_out");
  });
});
