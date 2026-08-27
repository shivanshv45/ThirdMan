import { formatPaise } from "@/lib/money";

/**
 * Display-only formatting on top of money.ts's formatPaise — comma
 * grouping and a split {rupees, paise} shape for components that want
 * to render the decimal portion smaller. Never a second conversion
 * path: this always goes through formatPaise first, so the paise ->
 * rupee arithmetic itself has exactly one implementation in the repo.
 */
export function formatPaiseGrouped(paise: number): string {
  const [sign, digits] = formatPaise(paise).split("₹");
  const [whole, decimal] = digits.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₹${grouped}.${decimal}`;
}

export function splitPaiseForDisplay(paise: number): { whole: string; decimal: string } {
  const grouped = formatPaiseGrouped(paise);
  const [whole, decimal] = grouped.split(".");
  return { whole, decimal };
}
