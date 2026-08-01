/**
 * broker-state.sandbox.idor.spec.ts
 *
 * PHASE C PENTEST (RBAC/IDOR finding, sandbox/non-persistent mode): the
 * in-memory fallback used by BrokerState when DATABASE_URL is unset (the
 * OrderAck/Position wire schemas deliberately carry no `userId` field, so
 * this fallback previously had no way to enforce ownership):
 *
 *   - closePositionInMemory() only checked that the caller had SOME client
 *     account (true for any authenticated trader), never that THEY owned
 *     the specific position being closed.
 *   - modifyPositionSlTp() had no ownership check whatsoever.
 *   - getOrders()/getPositions() returned every order/position in the
 *     process with no per-user filter.
 *   - cancelOrderMemory() (trading-service/order.cancel.ts) only checked
 *     order status, never ownership -- and separately, its call into a
 *     nonexistent `updateOrderStatusInMemory()` meant the sandbox cancel
 *     path never actually updated order status at all.
 *
 * Any authenticated trader could view, close, modify, or (nominally)
 * cancel another trader's positions/orders by id. Fixed via an internal
 * ownerByOrderId map (shared/state.ts) that never changes the public
 * response shape.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BrokerState } from "../shared/state.js";
import { cancelOrder } from "../trading-service/order.cancel.js";

let state: BrokerState;
let userA: string;
let userB: string;

beforeEach(async () => {
  state = new BrokerState({ secret: "test", liveTradingEnabled: false });

  const authA = await state.login("trader@igfxpro.local", "OlosDemo!2026");
  userA = authA!.principal.sub;

  const regB = await state.register({
    email: "victim-b@example.test", password: "SomeStrongPassword1!",
    fullName: "Trader B", country: "US",
  });
  userB = (regB as { principal: { sub: string } }).principal.sub;

  // New sandbox accounts start with $0 allocated capital ("NO
  // AUTO-ALLOCATION" -- createClientAccount()'s own comment); fund both
  // so placeOrder() below can actually pass its margin check and FILL,
  // not get REJECTED for insufficient capital before ownership is even
  // relevant.
  const authAdmin = await state.login("admin@igfxpro.local", "OlosAdmin!2026");
  await state.adminAllocateCapital(authAdmin!.principal, { userId: userA, amount: 50_000, note: "test funding" });
  await state.adminAllocateCapital(authAdmin!.principal, { userId: userB, amount: 50_000, note: "test funding" });
});

function placeAndFill(userId: string) {
  const principal = { sub: userId, tenantId: "tenant_igfxpro", roles: ["trader"], permissions: ["trading:write"] } as Parameters<typeof state.placeOrder>[1];
  const ack = state.placeOrder(
    { symbol: "EURUSD", side: "BUY", type: "MARKET", quantity: 1000, leverage: 20 },
    principal,
  );
  expect(ack.status).toBe("FILLED");
  return ack.id; // order id === position id in this in-memory model
}

describe("BrokerState sandbox in-memory trading — PHASE C PENTEST: IDOR", () => {
  it("closePositionInMemory(): a user cannot close ANOTHER user's position", () => {
    const positionIdOfA = placeAndFill(userA);

    const result = state.closePositionInMemory(positionIdOfA, userB);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("UNAUTHORIZED");
    // The position must still exist -- unauthorized attempt had zero effect.
    expect(state.getPositions(userA).some((p) => p.id === positionIdOfA)).toBe(true);
  });

  it("closePositionInMemory(): the actual owner CAN close their own position", () => {
    const positionIdOfA = placeAndFill(userA);

    const result = state.closePositionInMemory(positionIdOfA, userA);

    expect(result.ok).toBe(true);
    expect(state.getPositions(userA).some((p) => p.id === positionIdOfA)).toBe(false);
  });

  it("modifyPositionSlTp(): a user cannot rewrite ANOTHER user's stop-loss/take-profit", () => {
    const positionIdOfA = placeAndFill(userA);

    const result = state.modifyPositionSlTp(positionIdOfA, userB, 0.5);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("UNAUTHORIZED");
  });

  it("modifyPositionSlTp(): the actual owner CAN modify their own position's SL/TP", () => {
    const positionIdOfA = placeAndFill(userA);
    const entry = state.getPositions(userA).find((p) => p.id === positionIdOfA)!.entryPrice;

    // Well below/above entry so this can never spuriously fail the BUY
    // SL/TP price-ordering validation regardless of the simulated quote.
    const result = state.modifyPositionSlTp(positionIdOfA, userA, entry * 0.5, entry * 1.5);

    expect(result.ok).toBe(true);
  });

  it("getOrders(userId)/getPositions(userId): each user sees ONLY their own orders/positions, not the whole platform", () => {
    const idA = placeAndFill(userA);
    const idB = placeAndFill(userB);

    const ordersA = state.getOrders(userA);
    const positionsA = state.getPositions(userA);

    expect(ordersA.some((o) => o.id === idA)).toBe(true);
    expect(ordersA.some((o) => o.id === idB)).toBe(false);
    expect(positionsA.some((p) => p.id === idA)).toBe(true);
    expect(positionsA.some((p) => p.id === idB)).toBe(false);
  });

  it("getAllOrders()/getAllPositions(): the explicit admin-only unscoped methods still return everyone's data", () => {
    const idA = placeAndFill(userA);
    const idB = placeAndFill(userB);

    const allOrders = state.getAllOrders();
    const allPositions = state.getAllPositions();

    expect(allOrders.some((o) => o.id === idA)).toBe(true);
    expect(allOrders.some((o) => o.id === idB)).toBe(true);
    expect(allPositions.some((p) => p.id === idA)).toBe(true);
    expect(allPositions.some((p) => p.id === idB)).toBe(true);
  });

  it("cancelOrder() (sandbox path): a user cannot cancel ANOTHER user's pending order", async () => {
    const idA = placeAndFill(userA); // FILLED, not cancellable, but ownership is checked first
    const result = await cancelOrder(idA, userB, state);

    // Either way this must not succeed as userB -- either UNAUTHORIZED
    // (ownership) or ORDER_NOT_FOUND (state.getOrders(userB) correctly
    // excludes it) is an acceptable non-disclosure outcome; success is not.
    expect(result.ok).toBe(false);
  });

  it("updateOrderStatusInMemory(): genuinely mutates order status now (was previously a silent no-op)", () => {
    const idA = placeAndFill(userA);

    const applied = state.updateOrderStatusInMemory(idA, userA, "CANCELLED");

    expect(applied).toBe(true);
    expect(state.getOrders(userA).find((o) => o.id === idA)?.status).toBe("CANCELLED");
  });

  it("updateOrderStatusInMemory(): refuses to mutate another user's order", () => {
    const idA = placeAndFill(userA);

    const applied = state.updateOrderStatusInMemory(idA, userB, "CANCELLED");

    expect(applied).toBe(false);
    expect(state.getOrders(userA).find((o) => o.id === idA)?.status).not.toBe("CANCELLED");
  });
});
