import { PrismaClient } from "@prisma/client";
import { hash, argon2id } from "argon2";

const prisma = new PrismaClient();

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const;

async function main() {
  await prisma.tenant.upsert({
    where: { id: "tenant_igfxpro" },
    update: {},
    create: {
      id: "tenant_igfxpro",
      name: "IGFXPRO",
      region: "EU",
    },
  });

  const [traderHash, adminHash] = await Promise.all([
    hash("OlosDemo!2026", ARGON2_OPTIONS),
    hash("OlosAdmin!2026", ARGON2_OPTIONS),
  ]);

  await prisma.user.upsert({
    where: { email: "trader@igfxpro.local" },
    update: { password: traderHash },
    create: {
      id: "usr_trader_demo",
      email: "trader@igfxpro.local",
      password: traderHash,
      fullName: "IGFXPRO Trader",
      role: "trader",
      roles: ["trader"],
      permissions: ["trading:read", "trading:write", "wallet:read", "risk:read", "ai:read"],
      tier: "PLATINUM",
      kycStatus: "approved",
      tenantId: "tenant_igfxpro",
    },
  });

  await prisma.user.upsert({
    where: { email: "admin@igfxpro.local" },
    update: { password: adminHash },
    create: {
      id: "usr_admin_demo",
      email: "admin@igfxpro.local",
      password: adminHash,
      fullName: "IGFXPRO Admin",
      role: "admin",
      roles: ["admin", "compliance", "risk"],
      permissions: ["*"],
      tier: "ENTERPRISE",
      kycStatus: "approved",
      tenantId: "tenant_igfxpro",
    },
  });

  const instruments = [
    ["EURUSD", "Euro / US Dollar", "FX_MAJOR", "EUR", "USD", 5, 1000, 30],
    ["XAUUSD", "Gold Spot", "COMMODITY", "XAU", "USD", 2, 0.01, 10],
    ["US500", "US 500 Index CFD", "INDEX", "US500", "USD", 2, 0.1, 20],
    ["BTCUSD", "Bitcoin / US Dollar CFD", "CRYPTO", "BTC", "USD", 2, 0.001, 2],
    ["AAPL", "Apple CFD", "EQUITY", "AAPL", "USD", 2, 1, 5],
  ] as const;

  for (const [symbol, name, assetClass, base, quote, precision, minTradeSize, maxLeverageRetail] of instruments) {
    await prisma.instrument.upsert({
      where: { symbol },
      update: {},
      create: {
        symbol,
        name,
        assetClass,
        base,
        quote,
        precision,
        minTradeSize,
        maxLeverageRetail,
      },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
