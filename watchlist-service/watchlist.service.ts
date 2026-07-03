import { randomUUID }           from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type WatchlistRow = {
  id:        string;
  userId:    string;
  name:      string;
  symbols:   string[];
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

// ── In-memory sandbox fallback ─────────────────────────────────────────────────

const _sandbox = new Map<string, WatchlistRow[]>();

function sandboxLists(userId: string): WatchlistRow[] {
  if (!_sandbox.has(userId)) {
    const now = new Date().toISOString();
    _sandbox.set(userId, [
      {
        id: randomUUID(), userId, name: "Favorites",
        symbols: ["EURUSD", "XAUUSD", "BTCUSD"],
        isDefault: true, sortOrder: 0, createdAt: now, updatedAt: now,
      },
    ]);
  }
  return _sandbox.get(userId)!;
}

// ── WatchlistService ───────────────────────────────────────────────────────────

export class WatchlistService {

  async getAll(userId: string): Promise<WatchlistRow[]> {
    if (!IS_PERSISTENT) return sandboxLists(userId);

    const rows = await prisma!.watchlist.findMany({
      where:   { userId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    // Seed a default "Favorites" list for new users
    if (rows.length === 0) {
      const list = await this._create(userId, "Favorites", ["EURUSD", "XAUUSD", "BTCUSD"], true, 0);
      return [this._toRow(list)];
    }

    return rows.map(this._toRow);
  }

  async create(userId: string, name: string, symbols: string[] = []): Promise<WatchlistRow> {
    if (!IS_PERSISTENT) {
      const lists = sandboxLists(userId);
      if (lists.some((l) => l.name === name)) {
        throw Object.assign(new Error(`A watchlist named "${name}" already exists`), { statusCode: 409 });
      }
      const row: WatchlistRow = {
        id: randomUUID(), userId, name, symbols, isDefault: false,
        sortOrder: lists.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      lists.push(row);
      return row;
    }

    const existing = await prisma!.watchlist.findUnique({ where: { userId_name: { userId, name } } });
    if (existing) {
      throw Object.assign(new Error(`A watchlist named "${name}" already exists`), { statusCode: 409 });
    }

    const count = await prisma!.watchlist.count({ where: { userId } });
    return this._toRow(await this._create(userId, name, symbols, false, count));
  }

  async rename(id: string, userId: string, name: string): Promise<WatchlistRow> {
    const list = await this._requireOwned(id, userId);

    if (!IS_PERSISTENT) {
      list.name = name;
      list.updatedAt = new Date().toISOString();
      return list;
    }

    const conflict = await prisma!.watchlist.findUnique({ where: { userId_name: { userId, name } } });
    if (conflict && conflict.id !== id) {
      throw Object.assign(new Error(`A watchlist named "${name}" already exists`), { statusCode: 409 });
    }

    return this._toRow(await prisma!.watchlist.update({
      where: { id },
      data:  { name, updatedAt: new Date() },
    }));
  }

  async addSymbol(id: string, userId: string, symbol: string): Promise<WatchlistRow> {
    const list = await this._requireOwned(id, userId);
    const sym  = symbol.toUpperCase();

    if (!IS_PERSISTENT) {
      if (!list.symbols.includes(sym)) list.symbols = [...list.symbols, sym];
      list.updatedAt = new Date().toISOString();
      return list;
    }

    if (list.symbols.includes(sym)) return list;

    return this._toRow(await prisma!.watchlist.update({
      where: { id },
      data:  { symbols: [...list.symbols, sym], updatedAt: new Date() },
    }));
  }

  async removeSymbol(id: string, userId: string, symbol: string): Promise<WatchlistRow> {
    const list = await this._requireOwned(id, userId);
    const sym  = symbol.toUpperCase();

    const next = list.symbols.filter((s) => s !== sym);

    if (!IS_PERSISTENT) {
      list.symbols = next;
      list.updatedAt = new Date().toISOString();
      return list;
    }

    return this._toRow(await prisma!.watchlist.update({
      where: { id },
      data:  { symbols: next, updatedAt: new Date() },
    }));
  }

  async reorderSymbols(id: string, userId: string, symbols: string[]): Promise<WatchlistRow> {
    const list = await this._requireOwned(id, userId);

    // Only allow symbols already in the list
    const valid = symbols.filter((s) => list.symbols.includes(s.toUpperCase()));

    if (!IS_PERSISTENT) {
      list.symbols = valid;
      list.updatedAt = new Date().toISOString();
      return list;
    }

    return this._toRow(await prisma!.watchlist.update({
      where: { id },
      data:  { symbols: valid, updatedAt: new Date() },
    }));
  }

  async delete(id: string, userId: string): Promise<void> {
    const list = await this._requireOwned(id, userId);
    if (list.isDefault) {
      throw Object.assign(new Error("Cannot delete the default Favorites list"), { statusCode: 409 });
    }

    if (!IS_PERSISTENT) {
      const lists = sandboxLists(userId);
      _sandbox.set(userId, lists.filter((l) => l.id !== id));
      return;
    }

    await prisma!.watchlist.delete({ where: { id } });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _create(
    userId:    string,
    name:      string,
    symbols:   string[],
    isDefault: boolean,
    sortOrder: number,
  ) {
    return prisma!.watchlist.create({
      data: {
        id: randomUUID(),
        userId,
        name,
        symbols,
        isDefault,
        sortOrder,
        updatedAt: new Date(),
      },
    });
  }

  private async _requireOwned(id: string, userId: string): Promise<WatchlistRow> {
    if (!IS_PERSISTENT) {
      const row = sandboxLists(userId).find((l) => l.id === id);
      if (!row) throw Object.assign(new Error("Watchlist not found"), { statusCode: 404 });
      return row;
    }

    const row = await prisma!.watchlist.findUnique({ where: { id } });
    if (!row || row.userId !== userId) {
      throw Object.assign(new Error("Watchlist not found"), { statusCode: 404 });
    }
    return this._toRow(row);
  }

  private _toRow(row: {
    id: string; userId: string; name: string; symbols: string[];
    isDefault: boolean; sortOrder: number; createdAt: Date; updatedAt: Date;
  }): WatchlistRow {
    return {
      id:        row.id,
      userId:    row.userId,
      name:      row.name,
      symbols:   row.symbols,
      isDefault: row.isDefault,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export const watchlistService = new WatchlistService();
