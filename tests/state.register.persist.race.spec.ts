/**
 * state.register.persist.race.spec.ts
 *
 * FINAL DEPLOYMENT EXECUTION — found by rebuilding apiv2 from the current
 * commit and running the real cutover smoke-test package against it:
 * register (POST /api/v1/auth/register, BrokerState.register()) immediately
 * followed by login via the DB-backed POST /api/v1/auth/login/db (exactly
 * CUTOVER_PLAYBOOK.md's own smoke-test sequence, steps 3->4) failed with
 * INVALID_CREDENTIALS despite the correct password, reproducibly.
 *
 * Root cause: BrokerState.register() called `void this.persistUser(user)`
 * -- fire-and-forget. persistUser() re-hashes the password with real
 * Argon2id and upserts the row into the real database; register()'s HTTP
 * response returned before that upsert was guaranteed to have committed.
 * A client (or real user) that logs in via the DB-backed path immediately
 * after registering could race that write and be spuriously rejected.
 *
 * Fix: register() now `await`s persistUser()/persistClientAccount() before
 * returning, so the response is only sent once the DB row genuinely exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { BrokerState } = await import("../shared/state.js");

function makeMockPrismaWithDelayedUpsert(delayMs: number) {
  let persisted = false;
  const upsert = vi.fn(async (_args: { where: { email: string }; create: { password: string } }) => {
    await new Promise((r) => setTimeout(r, delayMs));
    persisted = true;
    return {};
  });
  const prismaLike: Record<string, unknown> = {
    user: { upsert },
  };
  return { prisma: prismaLike as unknown as PrismaClient, upsert, isPersisted: () => persisted };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BrokerState.register() persistence ordering", () => {
  it("REGRESSION GUARD: does not resolve until the real DB upsert has actually completed", async () => {
    const { prisma, upsert, isPersisted } = makeMockPrismaWithDelayedUpsert(30);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma });

    expect(isPersisted()).toBe(false);

    await state.register({
      email: "race-test@igfxpro.com",
      password: "CorrectHorseBattery9!",
      fullName: "Race Test",
      country: "US",
    });

    // The bug this guards against: register()'s promise resolving before
    // persistUser()'s upsert() promise itself resolves (fire-and-forget)
    // would make this assertion false -- a client that immediately calls
    // the DB-backed login path right after would find no committed row.
    expect(isPersisted()).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "race-test@igfxpro.com" },
        create: expect.objectContaining({ email: "race-test@igfxpro.com" }),
      }),
    );
  });

  it("stores an Argon2id hash (not the sandbox's own scrypt hash) in the persisted row, so the real DB-backed login path can verify it", async () => {
    const { prisma, upsert } = makeMockPrismaWithDelayedUpsert(0);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma });

    await state.register({
      email: "hash-format@igfxpro.com",
      password: "CorrectHorseBattery9!",
      fullName: "Hash Format",
      country: "US",
    });

    const call = upsert.mock.calls[0]![0];
    expect(call.create.password).toMatch(/^\$argon2id\$/);
  });

  it("still returns a usable session even though registration now awaits DB persistence", async () => {
    const { prisma } = makeMockPrismaWithDelayedUpsert(5);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma });

    const result = await state.register({
      email: "session-check@igfxpro.com",
      password: "CorrectHorseBattery9!",
      fullName: "Session Check",
      country: "US",
    });

    expect(result).toBeTruthy();
    expect((result as { principal?: { email?: string } }).principal?.email).toBe("session-check@igfxpro.com");
  });
});
