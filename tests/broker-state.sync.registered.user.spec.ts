/**
 * broker-state.sync.registered.user.spec.ts
 *
 * PRODUCTION CUTOVER Stage 3 — found via live shadow-environment testing: a
 * user created through the real, persistent registration path
 * (auth-service/auth.service.ts's register(), the only path a real
 * deployment uses) writes straight to Postgres and never touches
 * BrokerState.clientAccounts. That map is only ever populated at process
 * boot by hydrateFromDatabase(), so a brand-new client was invisible to
 * GET /api/v1/admin/client-accounts and GET /api/v1/admin/client/:email
 * (both backed by state.getClientAccounts()) until the next restart --
 * confirmed live: a freshly registered user via POST /auth/register/db
 * did not appear in either endpoint's response.
 *
 * Fix: authService.register() already emitted a "user.registered" event
 * (previously consumed only by notification.router.ts); main.ts now also
 * calls state.syncUserFromDatabase(event.userId), which upserts the new
 * user into the live in-memory maps the admin panel reads from.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { BrokerState } = await import("../shared/state.js");

function makeMockPrisma(user: Record<string, unknown> | null) {
  const prismaLike: Record<string, unknown> = {
    user: { findUnique: vi.fn(async () => user) },
  };
  return prismaLike as unknown as PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BrokerState.syncUserFromDatabase", () => {
  it("makes a freshly DB-registered trader immediately visible via getClientAccounts()", async () => {
    const prisma = makeMockPrisma({
      id: "new-user-1",
      email: "new.trader@igfxpro.com",
      password: "$argon2id$fake",
      fullName: "New Trader",
      tenantId: "tenant_igfxpro",
      tier: "STANDARD",
      role: "trader",
      roles: ["trader"],
      permissions: ["trading:read", "trading:write"],
      kycStatus: "not_started",
    });
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma });

    expect(state.getClientAccounts().find((a) => a.userId === "new-user-1")).toBeUndefined();

    await state.syncUserFromDatabase("new-user-1");

    const account = state.getClientAccounts().find((a) => a.userId === "new-user-1");
    expect(account).toBeDefined();
    expect(account!.profile.email).toBe("new.trader@igfxpro.com");
    expect(account!.profile.kycStatus).toBe("NOT_STARTED");
  });

  it("does not create a client account for a non-trader role (e.g. a support/admin user)", async () => {
    const prisma = makeMockPrisma({
      id: "new-admin-1",
      email: "new.admin@igfxpro.com",
      password: "$argon2id$fake",
      fullName: "New Admin",
      tenantId: "tenant_igfxpro",
      tier: "ENTERPRISE",
      role: "admin",
      roles: ["admin"],
      permissions: ["*"],
      kycStatus: "approved",
    });
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma });

    await state.syncUserFromDatabase("new-admin-1");

    expect(state.getClientAccounts().find((a) => a.userId === "new-admin-1")).toBeUndefined();
  });

  it("is a no-op when the user id does not exist in the database", async () => {
    const prisma = makeMockPrisma(null);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma });
    const before = state.getClientAccounts().length;

    await expect(state.syncUserFromDatabase("ghost-id")).resolves.toBeUndefined();
    expect(state.getClientAccounts()).toHaveLength(before);
    expect(state.getClientAccounts().find((a) => a.userId === "ghost-id")).toBeUndefined();
  });

  it("is a no-op in sandbox mode (no prisma configured)", async () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false }); // no prisma

    await expect(state.syncUserFromDatabase("any-id")).resolves.toBeUndefined();
  });

  it("does not duplicate an existing client account when called twice", async () => {
    const prisma = makeMockPrisma({
      id: "new-user-2",
      email: "twice@igfxpro.com",
      password: "$argon2id$fake",
      fullName: "Twice",
      tenantId: "tenant_igfxpro",
      tier: "STANDARD",
      role: "trader",
      roles: ["trader"],
      permissions: ["trading:read"],
      kycStatus: "not_started",
    });
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma });

    await state.syncUserFromDatabase("new-user-2");
    await state.syncUserFromDatabase("new-user-2");

    expect(state.getClientAccounts().filter((a) => a.userId === "new-user-2")).toHaveLength(1);
  });
});
