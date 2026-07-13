/**
 * null.hedge.provider.spec.ts
 *
 * FASE 3.8 — Internal Liquidity Engine (Group D: hedge scaffold).
 *
 * NullExternalHedgeProvider must always reject, honestly — this is the
 * safe default until a real external LP is configured, not a bug to fix.
 */
import { describe, it, expect } from "vitest";
import { NullExternalHedgeProvider } from "../hedge-service/null.hedge.provider.js";

describe("NullExternalHedgeProvider", () => {
  it("reports isConfigured=false", () => {
    const provider = new NullExternalHedgeProvider();
    expect(provider.isConfigured).toBe(false);
  });

  it("always rejects placeHedgeOrder, resolving (never throwing)", async () => {
    const provider = new NullExternalHedgeProvider();
    const result = await provider.placeHedgeOrder({ symbol: "EURUSD", side: "BUY", notional: 1_000_000 });

    expect(result.status).toBe("REJECTED");
    expect((result as { reason: string }).reason).toContain("NO_EXTERNAL_LP_CONFIGURED");
  });

  it("includes the requested side/notional/symbol in the rejection reason", async () => {
    const provider = new NullExternalHedgeProvider();
    const result = await provider.placeHedgeOrder({ symbol: "XAUUSD", side: "SELL", notional: 250_000 });

    expect((result as { reason: string }).reason).toContain("SELL");
    expect((result as { reason: string }).reason).toContain("XAUUSD");
    expect((result as { reason: string }).reason).toContain("250000.00");
  });
});
