/**
 * notification.router.autopilot.spec.ts
 *
 * Task 14, Phase 2 — confirms NotificationRouter.subscribe() now listens to
 * all 4 autopilot events (autopilot.executed, autopilot.rejected,
 * autopilot.position_managed, autopilot.config_changed) and dispatches each
 * with the right channel/category/priority. send()/sendAll() themselves are
 * spied and short-circuited — this file only verifies the event-to-dispatch
 * mapping, not the DB-backed delivery mechanics (already covered implicitly
 * by how every other listener in this router already works).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eventBus } from "../events-bus/event.bus.js";
import { notificationRouter } from "../notification-service/notification.router.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sendSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sendAllSpy: any;

beforeAll(() => {
  sendSpy = vi.spyOn(notificationRouter, "send").mockResolvedValue(undefined);
  sendAllSpy = vi.spyOn(notificationRouter, "sendAll").mockResolvedValue(undefined);
  notificationRouter.subscribe();
});

beforeEach(() => {
  sendSpy.mockClear();
  sendAllSpy.mockClear();
});

describe("NotificationRouter — autopilot.executed", () => {
  it("dispatches via sendAll with category=autopilot, priority=NORMAL", () => {
    eventBus.emit("autopilot.executed", {
      userId: "user-1", orderId: "order-1", symbol: "EURUSD", side: "BUY",
      reason: "Signal conf=80%", timestamp: new Date().toISOString(),
    });

    expect(sendAllSpy).toHaveBeenCalledWith(
      "user-1", "autopilot", "NORMAL",
      expect.stringContaining("EURUSD"),
      expect.stringContaining("BUY"),
      expect.anything(),
    );
  });
});

describe("NotificationRouter — autopilot.rejected", () => {
  it("dispatches via sendAll with category=autopilot, priority=HIGH, and the reject reason as the body", () => {
    eventBus.emit("autopilot.rejected", {
      userId: "user-1", symbol: "EURUSD", reason: "Drawdown 12.0% exceeds stop limit 10%",
      timestamp: new Date().toISOString(),
    });

    expect(sendAllSpy).toHaveBeenCalledWith(
      "user-1", "autopilot", "HIGH",
      expect.stringContaining("EURUSD"),
      "Drawdown 12.0% exceeds stop limit 10%",
      expect.anything(),
    );
  });
});

describe("NotificationRouter — autopilot.position_managed", () => {
  it.each([
    ["REGIME_EXIT", "regime reversed"],
    ["TIME_STOP", "no progress"],
    ["BREAK_EVEN", "break-even"],
    ["TRAILING_STOP", "Trailing stop tightened"],
  ] as const)("dispatches IN_APP-only for %s with an action-specific body", (action, expectedSubstring) => {
    eventBus.emit("autopilot.position_managed", {
      positionId: "pos-1", userId: "user-1", symbol: "EURUSD", action,
      stopLoss: action === "TRAILING_STOP" ? 1.105 : undefined,
      timestamp: new Date().toISOString(),
    });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", channel: "IN_APP", category: "autopilot", priority: "NORMAL",
      body: expect.stringContaining(expectedSubstring),
    }));
    // IN_APP-only — never escalated to email via sendAll for this high-frequency event.
    expect(sendAllSpy).not.toHaveBeenCalled();
  });
});

describe("NotificationRouter — autopilot.config_changed", () => {
  it("dispatches IN_APP-only, LOW priority, confirming the new enabled state", () => {
    eventBus.emit("autopilot.config_changed", { userId: "user-1", enabled: true, timestamp: new Date().toISOString() });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", channel: "IN_APP", category: "autopilot", priority: "LOW",
      body: expect.stringContaining("ON"),
    }));
  });

  it("reports OFF when enabled is false", () => {
    eventBus.emit("autopilot.config_changed", { userId: "user-1", enabled: false, timestamp: new Date().toISOString() });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("OFF") }));
  });
});
