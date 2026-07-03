/**
 * seed.ts — Load test user seeder.
 *
 * Creates N funded users directly in the database, each with:
 *   - User row (with scrypt password hash matching "TestPass123!")
 *   - WalletAccount ($10,000 balance)
 *   - LedgerEntry (ADMIN_CAPITAL_ALLOCATION, with double-entry accounts)
 *
 * Usage: npx tsx tests/load/seed.ts [count]
 *   count defaults to 100
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { scryptSync, randomBytes } from "node:crypto";

const db = new PrismaClient({ log: [] });

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function seedUsers(count: number): Promise<{ userIds: string[]; tokens: string[] }> {
  const userIds: string[] = [];
  const emails:  string[] = [];

  console.log(`[seed] creating ${count} test users...`);

  const password = hashPassword("TestPass123!");

  for (let i = 0; i < count; i++) {
    const userId = `loadtest-user-${String(i).padStart(5, "0")}`;
    const email  = `loadtest-${String(i).padStart(5, "0")}@igfxpro-loadtest.internal`;

    await db.$transaction(async (tx) => {
      // Upsert user (idempotent re-seed)
      await tx.user.upsert({
        where: { id: userId },
        create: {
          id:          userId,
          email,
          password,
          fullName:    `Load Test User ${i}`,
          role:        "client",
          roles:       ["client"],
          permissions: [],
          tier:        "STANDARD",
          kycStatus:   "approved",
          tenantId:    await ensureTenant(tx),
        },
        update: { kycStatus: "approved" },
      });

      // Upsert wallet
      await tx.walletAccount.upsert({
        where:  { userId },
        create: { userId, currency: "USD", balance: new Prisma.Decimal(10_000), locked: new Prisma.Decimal(0) },
        update: { balance: new Prisma.Decimal(10_000), locked: new Prisma.Decimal(0) },
      });

      // Ensure capital allocation ledger entry
      const ref = `LOAD_SEED:${userId}`;
      const existing = await tx.ledgerEntry.findFirst({ where: { reference: ref } });
      if (!existing) {
        await tx.ledgerEntry.create({
          data: {
            id:            `le-load-${userId}`,
            userId,
            currency:      "USD",
            amount:        new Prisma.Decimal(10_000),
            type:          "ADMIN_CAPITAL_ALLOCATION",
            reference:     ref,
            status:        "COMPLETED",
            note:          `Load test seed capital for ${userId}`,
            debitAccount:  "BROKER_FLOAT",
            creditAccount: `CLIENT:${userId}`,
          },
        });
      }
    });

    userIds.push(userId);
    emails.push(email);

    if ((i + 1) % 50 === 0) console.log(`[seed] ${i + 1}/${count} users created`);
  }

  console.log(`[seed] done — ${count} users seeded`);
  return { userIds, tokens: emails }; // k6 uses email as login identifier
}

let _tenantId: string | null = null;
async function ensureTenant(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">): Promise<string> {
  if (_tenantId) return _tenantId;
  const existing = await tx.tenant.findFirst();
  if (existing) { _tenantId = existing.id; return _tenantId; }
  _tenantId = "tenant-loadtest";
  await tx.tenant.create({ data: { id: _tenantId, name: "Load Test Tenant", region: "EU" } });
  return _tenantId;
}

async function cleanupUsers(count: number): Promise<void> {
  console.log(`[seed] cleaning up ${count} load test users...`);
  for (let i = 0; i < count; i++) {
    const userId = `loadtest-user-${String(i).padStart(5, "0")}`;
    await db.ledgerEntry.deleteMany({ where: { userId } });
    await db.walletAccount.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
  }
  console.log("[seed] cleanup complete");
}

// ── CLI entry point ────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const action = args[0] ?? "seed";
const count  = parseInt(args[1] ?? "100");

if (action === "cleanup") {
  await cleanupUsers(count);
} else {
  const { userIds } = await seedUsers(count);
  // Write user IDs to stdout for k6 to consume
  console.log("SEEDED_USER_IDS:" + userIds.join(","));
}

await db.$disconnect();
