/**
 * The only place paise <-> rupees conversion happens. Money is stored
 * and computed as integer paise everywhere else (CLAUDE.md rule 3) —
 * these two functions are the display/input edge, and nowhere else.
 */

/** Formats integer paise as a rupee string for display, e.g. 850000 -> "₹8500.00". */
export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

/**
 * Parses a rupee amount from a form input into integer paise. Rounds
 * rather than truncates, so a value like "10.005" (a browser number
 * input can produce this via floating point) doesn't silently lose a
 * paisa. Throws on a negative or non-finite input — callers on a money
 * path should treat that as invalid input, not coerce it.
 */
export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees < 0) {
    throw new Error(`rupeesToPaise: ${rupees} is not a valid non-negative amount`);
  }
  return Math.round(rupees * 100);
}
