/**
 * feed.manager.circuit.alert.delivery.spec.ts
 *
 * PHASE E (failure-injection audit): FeedManager's FEED_CIRCUIT_OPEN alert
 * (all price feeds dead for CIRCUIT_BREAK_MS, new orders blocked) previously
 * had to bypass eventBus's types entirely --
 * `(eventBus.emit as (...args: unknown[]) => void)("risk.warning", {...})`
 * -- because RiskWarningEvent.userId was required, and this is a
 * platform-wide condition with no single affected user. That type-bypass
 * hid a real delivery bug: main.ts's "risk.warning" handler only ever did
 * `enqueueAndPush(event.userId, ...)`, which requires a real connected
 * client whose userId exactly matches -- with `event.userId` undefined at
 * runtime, this could never deliver to anyone, and unlike the sibling
 * compliance.alert/margin.warning handlers, it never called pushToStaff()
 * either. So a CRITICAL, all-feeds-dead, orders-blocked condition was
 * silently invisible to every connected client, including staff.
 *
 * Fix: RiskWarningEvent.userId is now optional (events-bus/event.bus.ts).
 * FeedManager emits cleanly, no cast. main.ts's handler (not directly
 * testable -- it starts a live HTTP/WS server unconditionally on import,
 * consistent with every other main.ts handler in this codebase; see
 * margin.warning.pipeline.spec.ts and ws.token.expiry.spec.ts, neither of
 * which imports main.ts either) now skips enqueueAndPush() when userId is
 * absent and calls pushToStaff("admin.risk_alert", event, ["super_admin",
 * "admin", "risk"]) for CRITICAL severity regardless -- verified by
 * `npx tsc --noEmit` plus manual code review, the same verification level
 * used for the parallel guard this segment added to notification.router.ts
 * below (which IS directly testable, since it's a real importable module).
 *
 * This file covers the two genuinely testable seams:
 *   1. FeedManager._openCircuit() emits a well-formed, userId-less CRITICAL
 *      "risk.warning" event on the real eventBus (producer-side proof).
 *   2. notification.router.ts's "risk.warning" listener -- which previously
 *      would have thrown a TS error trying to pass `userId: string |
 *      undefined` into `send()`'s required `userId: string` -- correctly
 *      skips userId-less events (no bogus per-user IN_APP row for a
 *      platform-wide alert) while still handling real per-user risk
 *      warnings (settlement.engine.ts's post-liquidation summary) exactly
 *      as before.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1") }));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));

const mockNotificationPreference = { findUnique: vi.fn().mockResolvedValue(null) };
const mockNotificationCreate     = vi.fn().mockResolvedValue({});
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    notificationPreference: mockNotificationPreference,
    notification: { create: mockNotificationCreate },
    user: { findUnique: vi.fn().mockResolvedValue({ email: "u@example.test" }) },
  },
}));
vi.mock("../notification-service/email.sender.js", () => ({
  emailSender: { send: vi.fn().mockResolvedValue(undefined) },
}));

const { eventBus }           = await import("../events-bus/event.bus.js");
const { FeedManager }        = await import("../market-data/feed.manager.js");
const { notificationRouter } = await import("../notification-service/notification.router.js");

function makeManager() {
  return new FeedManager({
    apiKey: "test-key", symbols: ["EURUSD"], wsSymbols: [], ingestPrice: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNotificationPreference.findUnique.mockResolvedValue(null);
  mockNotificationCreate.mockResolvedValue({});
});

describe("FeedManager._openCircuit() — PHASE E: emits a clean, userId-less CRITICAL risk.warning", () => {
  it("emits severity=CRITICAL, reason=FEED_CIRCUIT_OPEN, no userId, no type cast needed", () => {
    const fm = makeManager();
    const received: unknown[] = [];
    const listener = (e: unknown) => received.push(e);
    eventBus.on("risk.warning", listener);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fm as any)._openCircuit();
    } finally {
      eventBus.off("risk.warning", listener);
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      severity: "CRITICAL",
      reason:   "FEED_CIRCUIT_OPEN",
      message:  expect.stringContaining("blocked"),
    });
    expect((received[0] as { userId?: string }).userId).toBeUndefined();
  });
});

describe("notification.router.ts — risk.warning listener, userId-less events (PHASE E)", () => {
  beforeAll(() => notificationRouter.subscribe());

  it("does NOT attempt to persist an IN_APP notification for a userId-less platform-wide alert", async () => {
    eventBus.emit("risk.warning", {
      severity: "CRITICAL", reason: "FEED_CIRCUIT_OPEN",
      message: "All market data feeds offline — new orders blocked",
      timestamp: new Date().toISOString(),
    });

    // send() is async/fire-and-forget from the listener; give it a tick.
    await new Promise((r) => setTimeout(r, 10));

    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("still persists a normal per-user risk.warning exactly as before (no regression from the new guard)", async () => {
    eventBus.emit("risk.warning", {
      userId: "user-1", severity: "HIGH", message: "Margin level dropped to 60%",
      marginLevel: 60, timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    const [args] = mockNotificationCreate.mock.calls[0]!;
    expect(args.data).toMatchObject({ userId: "user-1", category: "risk" });
  });
});
