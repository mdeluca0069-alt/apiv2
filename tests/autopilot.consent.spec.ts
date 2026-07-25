/**
 * autopilot.consent.spec.ts
 *
 * Real-client safety layer — recorded acceptance of the autopilot risk
 * disclosure. AutopilotConsent rows are append-only; AutopilotConfig keeps a
 * denormalized copy for fast reads.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// REALTIME_FREEZE.md Critical #2: autopilot.consent.ts now routes through
// immutableAudit.write() (real module, not mocked) instead of calling
// prisma.auditLog.create() directly -- $transaction/$queryRaw/
// auditLog.findFirst satisfy its chain-head lock and lookup.
const { mockConsentCreate, mockConfigUpsert, mockConfigFindUnique, mockAuditCreate, mockPrisma } = vi.hoisted(() => {
  const mockConsentCreate  = vi.fn().mockResolvedValue({});
  const mockConfigUpsert   = vi.fn().mockResolvedValue({});
  const mockConfigFindUnique = vi.fn();
  const mockAuditCreate    = vi.fn().mockResolvedValue({});
  const mockPrisma: Record<string, unknown> = {
    autopilotConsent: { create: mockConsentCreate },
    autopilotConfig:  { upsert: mockConfigUpsert, findUnique: mockConfigFindUnique },
    auditLog:         { create: mockAuditCreate },
    $executeRaw:      vi.fn().mockResolvedValue(0),
    $queryRaw:        vi.fn().mockResolvedValue([]),
  };
  mockPrisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(mockPrisma));
  return { mockConsentCreate, mockConfigUpsert, mockConfigFindUnique, mockAuditCreate, mockPrisma };
});

let isPersistent = true;

vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return isPersistent; },
  prisma: mockPrisma,
}));

import { AutopilotConsentService, CURRENT_CONSENT_VERSION } from "../autopilot-service/autopilot.consent.js";

beforeEach(() => {
  isPersistent = true;
  mockConsentCreate.mockReset().mockResolvedValue({});
  mockConfigUpsert.mockReset().mockResolvedValue({});
  mockConfigFindUnique.mockReset();
  mockAuditCreate.mockReset().mockResolvedValue({});
});

describe("AutopilotConsentService.hasValidConsent", () => {
  it("is true only when version matches current and a timestamp is present", () => {
    const svc = new AutopilotConsentService();
    expect(svc.hasValidConsent({ consentVersion: CURRENT_CONSENT_VERSION, consentAcceptedAt: new Date() })).toBe(true);
    expect(svc.hasValidConsent({ consentVersion: "old-version", consentAcceptedAt: new Date() })).toBe(false);
    expect(svc.hasValidConsent({ consentVersion: CURRENT_CONSENT_VERSION, consentAcceptedAt: null })).toBe(false);
    expect(svc.hasValidConsent({})).toBe(false);
  });
});

describe("AutopilotConsentService.acceptConsent", () => {
  it("inserts an append-only consent row, updates the config, and writes an audit log entry", async () => {
    const svc = new AutopilotConsentService();
    await svc.acceptConsent("user-1", "user-1");

    expect(mockConsentCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "user-1", version: CURRENT_CONSENT_VERSION }),
    }));
    expect(mockConfigUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1" },
    }));
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "autopilot.consent_accepted", entity: "user-1" }),
    }));
  });

  it("records in memory only on the sandbox path, without DB calls", async () => {
    isPersistent = false;
    const svc = new AutopilotConsentService();
    await svc.acceptConsent("user-2", "user-2");
    expect(mockConsentCreate).not.toHaveBeenCalled();

    const status = await svc.getStatus("user-2");
    expect(status.accepted).toBe(true);
  });
});

describe("AutopilotConsentService.getStatus", () => {
  it("reports accepted=false when no consent has been recorded", async () => {
    mockConfigFindUnique.mockResolvedValue(null);
    const svc = new AutopilotConsentService();
    const status = await svc.getStatus("user-3");
    expect(status.accepted).toBe(false);
    expect(status.version).toBe(CURRENT_CONSENT_VERSION);
  });

  it("reports accepted=true when the denormalized version matches current", async () => {
    mockConfigFindUnique.mockResolvedValue({ consentVersion: CURRENT_CONSENT_VERSION, consentAcceptedAt: new Date() });
    const svc = new AutopilotConsentService();
    const status = await svc.getStatus("user-4");
    expect(status.accepted).toBe(true);
  });

  it("reports accepted=false when an older consent version was accepted", async () => {
    mockConfigFindUnique.mockResolvedValue({ consentVersion: "stale-version", consentAcceptedAt: new Date() });
    const svc = new AutopilotConsentService();
    const status = await svc.getStatus("user-5");
    expect(status.accepted).toBe(false);
  });
});
