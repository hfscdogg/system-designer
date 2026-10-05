/** All arithmetic is in integer cents (PRD §10.2: code owns arithmetic). */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error(`not a finite amount: ${dollars}`);
  return Math.round(dollars * 100);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
