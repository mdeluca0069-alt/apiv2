import { describe, expect, it } from "vitest";
import { BrokerState } from "../shared/state.js";

describe("BrokerState", () => {
  it("enforces ESMA leverage caps before filling sandbox orders", async () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    const auth = await state.login("trader@igfxpro.local", "OlosDemo!2026");
    expect(auth).toBeTruthy();

    const rejected = state.placeOrder(
      {
        symbol: "BTCUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
        leverage: 10,
      },
      auth!.principal
    );

    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectionReason).toContain("ESMA");
  });

  it("fills compliant sandbox orders and opens positions", async () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    const auth = await state.login("trader@igfxpro.local", "OlosDemo!2026");
    expect(auth).toBeTruthy();

    const filled = state.placeOrder(
      {
        symbol: "EURUSD",
        side: "BUY",
        type: "MARKET",
        quantity: 1000,
        leverage: 20,
      },
      auth!.principal
    );

    expect(filled.status).toBe("FILLED");
    expect(state.getPositions()).toHaveLength(1);
  });
});
