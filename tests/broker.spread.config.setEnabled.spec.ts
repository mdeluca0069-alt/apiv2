/**
 * broker.spread.config.setEnabled.spec.ts
 *
 * FASE 3.2 — Internal Liquidity Engine.
 *
 * Proves BrokerSpreadConfig.setEnabled() toggles only the enabled flag,
 * preserving whatever spread is already configured — added specifically so
 * automated callers (the circuit breaker) never have to invent a spread
 * value just to flip enabled on or off.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../shared/db.js", () => ({ prisma: null, IS_PERSISTENT: false }));

const { BrokerSpreadConfig } = await import("../liquidity-engine/broker.spread.config.js");

describe("BrokerSpreadConfig.setEnabled()", () => {
  let config: InstanceType<typeof BrokerSpreadConfig>;

  beforeEach(() => {
    config = new BrokerSpreadConfig();
  });

  it("disables a symbol without changing its default spread", async () => {
    const before = config.getSpread("EURUSD");

    await config.setEnabled("EURUSD", false, "system:circuit-breaker");

    expect(config.isEnabled("EURUSD")).toBe(false);
    expect(config.getSpread("EURUSD")).toBe(before);
  });

  it("preserves a previously-set custom spread when toggling enabled", async () => {
    await config.update("EURUSD", 0.0005, true, "admin-1");

    await config.setEnabled("EURUSD", false, "system:circuit-breaker");

    expect(config.getSpread("EURUSD")).toBe(0.0005);
    expect(config.isEnabled("EURUSD")).toBe(false);
  });

  it("re-enables a symbol, still preserving its spread", async () => {
    await config.setEnabled("EURUSD", false, "system:circuit-breaker");
    await config.setEnabled("EURUSD", true, "system:circuit-breaker");

    expect(config.isEnabled("EURUSD")).toBe(true);
  });

  it("attributes the actor that made the change", async () => {
    await config.setEnabled("EURUSD", false, "system:circuit-breaker");

    const entry = config.getAll().EURUSD;
    expect(entry.updatedBy).toBe("system:circuit-breaker");
  });
});
