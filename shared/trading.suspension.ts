/**
 * TradingSuspension — per-user trading halt registry.
 *
 * Users are suspended by RecoveryService at startup when a margin deficit
 * (wallet.locked < SUM open position margins) is detected. This state cannot
 * be auto-repaired; a human admin must review and manually unsuspend.
 *
 * Suspension is in-memory only. It is re-evaluated on every server restart by
 * RecoveryService, which re-adds any still-deficient users to the set.
 *
 * Admin API endpoints:
 *   GET  /api/v1/admin/suspended-users        — list all suspended users
 *   POST /api/v1/admin/suspended-users/:id/unsuspend — unsuspend a user
 */

type SuspensionRecord = {
  userId:    string;
  reason:    string;
  suspendedAt: Date;
};

class TradingSuspension {
  private readonly records = new Map<string, SuspensionRecord>();

  suspend(userId: string, reason: string): void {
    if (this.records.has(userId)) return; // already suspended — do not overwrite
    this.records.set(userId, { userId, reason, suspendedAt: new Date() });
    console.error(
      `[trading-suspension] TRADING SUSPENDED for userId=${userId} reason="${reason}" — admin review required`
    );
  }

  unsuspend(userId: string): boolean {
    const had = this.records.has(userId);
    this.records.delete(userId);
    if (had) {
      console.warn(`[trading-suspension] userId=${userId} unsuspended by admin`);
    }
    return had;
  }

  isSuspended(userId: string): boolean {
    return this.records.has(userId);
  }

  getSuspension(userId: string): SuspensionRecord | undefined {
    return this.records.get(userId);
  }

  getSuspendedUsers(): SuspensionRecord[] {
    return [...this.records.values()].sort(
      (a, b) => a.suspendedAt.getTime() - b.suspendedAt.getTime()
    );
  }

  count(): number {
    return this.records.size;
  }

  /** Used in tests only — clears all suspension records. */
  _clearForTests(): void {
    this.records.clear();
  }
}

export const tradingSuspension = new TradingSuspension();
