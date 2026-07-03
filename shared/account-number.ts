/**
 * Deterministic, human-readable account number derived from the real user
 * ID — no separate schema column needed, no randomness, stable forever for
 * a given account (same input always produces the same number).
 */
import { createHash } from "node:crypto";

export function formatAccountNumber(userId: string): string {
  const hash = createHash("sha256").update(userId).digest("hex");
  const num  = parseInt(hash.slice(0, 9), 16) % 10_000_000; // 7 digits
  return `100${num.toString().padStart(7, "0")}`; // e.g. 1000482913
}
