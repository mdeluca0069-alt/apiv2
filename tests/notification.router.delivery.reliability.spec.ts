/**
 * notification.router.delivery.reliability.spec.ts
 *
 * PHASE E (failure-injection audit): every call site of
 * NotificationRouter.send()/sendAll() (margin.warning, kyc.rejected,
 * compliance.alert, etc. -- see subscribe()) fires `void`, since a
 * failing notification must never block or roll back the business
 * transaction that triggered it. But that meant any throw from send()
 * (e.g. db.notification.create() failing during exactly the kind of DB
 * load spike a stop-out wave causes) became an unhandled promise
 * rejection, silently discarded by main.ts's non-fatal
 * unhandledRejection handler -- a client could genuinely never learn
 * their account was margin-called, stopped out, or that their KYC was
 * rejected, purely because of a transient DB hiccup at the wrong
 * instant, with zero record anywhere that this happened.
 *
 * Fix: send() now retries the DB write once, and if that also fails,
 * writes a durable immutableAudit record capturing the notification that
 * was about to be lost (action="notification.delivery_failed") instead
 * of letting the failure vanish into a discarded promise rejection.
 * send() itself now never throws past that point.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id") }));
vi.mock("../security/immutable.audit.js", () => ({ immutableAudit: { write: mockAuditWrite } }));

const mockNotificationPreference = { findUnique: vi.fn().mockResolvedValue(null) };
const mockNotificationCreate = vi.fn().mockResolvedValue({});
const mockUserFindUnique = vi.fn().mockResolvedValue({ email: "user@example.test" });

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    notificationPreference: mockNotificationPreference,
    notification: { create: mockNotificationCreate },
    user: { findUnique: mockUserFindUnique },
  },
}));

vi.mock("../notification-service/email.sender.js", () => ({
  emailSender: { send: vi.fn().mockResolvedValue(undefined) },
}));

const { notificationRouter } = await import("../notification-service/notification.router.js");

function marginCallNotif() {
  return {
    userId: "user-1", channel: "IN_APP" as const, category: "margin" as const,
    priority: "CRITICAL" as const, title: "Margin Call",
    body: "Margin level is 95%. Add funds immediately.",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNotificationPreference.findUnique.mockResolvedValue(null);
  mockNotificationCreate.mockResolvedValue({});
  mockUserFindUnique.mockResolvedValue({ email: "user@example.test" });
});

describe("NotificationRouter.send() — PHASE E: delivery reliability under transient DB failure", () => {
  it("persists normally when the DB write succeeds on the first attempt", async () => {
    await notificationRouter.send(marginCallNotif());

    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditWrite).not.toHaveBeenCalled();
  });

  it("RETRY: a single transient DB failure is absorbed by one retry -- the notification is still persisted, no durable-failure record needed", async () => {
    mockNotificationCreate
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({});

    await notificationRouter.send(marginCallNotif());

    expect(mockNotificationCreate).toHaveBeenCalledTimes(2);
    expect(mockAuditWrite).not.toHaveBeenCalled();
  });

  it("PERSISTENT FAILURE: after the retry also fails, send() does NOT throw (no unhandled rejection) and durably records the lost notification", async () => {
    mockNotificationCreate.mockRejectedValue(new Error("connection pool exhausted"));

    // The core regression this proves: previously this would reject and,
    // since every real call site is `void this.send(...)`/`void
    // this.sendAll(...)`, become an unhandled rejection silently
    // discarded by main.ts -- send() itself must never throw past its
    // own retry+audit fallback.
    await expect(notificationRouter.send(marginCallNotif())).resolves.toBeUndefined();

    expect(mockNotificationCreate).toHaveBeenCalledTimes(2); // original + 1 retry
    expect(mockAuditWrite).toHaveBeenCalledWith(expect.objectContaining({
      actor:  "notification-router",
      action: "notification.delivery_failed",
      entity: "user-1",
      payload: expect.objectContaining({
        category: "margin", priority: "CRITICAL", title: "Margin Call",
      }),
    }));
  });

  it("a preference-lookup failure is also caught -- does not throw, still durably records the loss", async () => {
    mockNotificationPreference.findUnique.mockRejectedValue(new Error("DB timeout"));

    await expect(notificationRouter.send(marginCallNotif())).resolves.toBeUndefined();

    expect(mockNotificationCreate).not.toHaveBeenCalled(); // never reached the write
    expect(mockAuditWrite).toHaveBeenCalledWith(expect.objectContaining({ action: "notification.delivery_failed" }));
  });

  it("even if the durable audit write ALSO fails, send() still does not throw (last-resort console-only, never crashes the caller)", async () => {
    mockNotificationCreate.mockRejectedValue(new Error("db down"));
    mockAuditWrite.mockRejectedValue(new Error("audit db also down"));

    await expect(notificationRouter.send(marginCallNotif())).resolves.toBeUndefined();
  });

  it("channel preference opt-out still short-circuits before ever touching the DB write (unrelated to the reliability fix)", async () => {
    mockNotificationPreference.findUnique.mockResolvedValue({
      emailEnabled: true, smsEnabled: true, pushEnabled: true, inAppEnabled: false, categories: {},
    });

    await notificationRouter.send(marginCallNotif()); // IN_APP, but inAppEnabled:false

    expect(mockNotificationCreate).not.toHaveBeenCalled();
    expect(mockAuditWrite).not.toHaveBeenCalled();
  });
});
