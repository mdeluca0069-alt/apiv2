/**
 * feed.manager.force.refresh.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found that
 * POST /admin/feed/refresh (FeedManager.forceRefreshAll()) had zero call
 * into the permanent, hash-chained AuditLog. This bypasses the normal
 * rotation timer and force-fetches a REST snapshot for every configured
 * symbol on admin demand.
 *
 * forceRefreshAll()'s new `actor` param is only supplied by the admin
 * route -- there is no other caller in this codebase, so the "system path
 * stays unaudited" behavior is proven simply by omitting the argument.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1") }));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));

const { mockFetchCurrentPrices } = vi.hoisted(() => ({
  mockFetchCurrentPrices: vi.fn().mockResolvedValue(new Map([["EUR/USD", 1.0870]])),
}));
vi.mock("../market-data/feeds/twelvedata.rest.js", () => ({
  fetchCurrentPrices: mockFetchCurrentPrices,
}));

const { FeedManager } = await import("../market-data/feed.manager.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditWrite.mockResolvedValue("audit-id-1");
  mockFetchCurrentPrices.mockResolvedValue(new Map([["EUR/USD", 1.0870]]));
});

function makeManager() {
  return new FeedManager({
    apiKey: "test-key",
    symbols: ["EURUSD"],
    wsSymbols: [],
    ingestPrice: vi.fn(),
  });
}

describe("FeedManager.forceRefreshAll() — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("writes an immutable audit entry when an actor is supplied (the admin route path)", async () => {
    const fm = makeManager();

    const refreshed = await fm.forceRefreshAll("admin-1");

    expect(refreshed).toBe(1);
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor:  "admin-1",
      action: "feed.force_refresh",
      entity: "platform",
      payload: { refreshed: 1 },
    });
  });

  it("does not write an audit entry when no actor is supplied", async () => {
    const fm = makeManager();

    await fm.forceRefreshAll();

    expect(mockAuditWrite).not.toHaveBeenCalled();
  });
});
