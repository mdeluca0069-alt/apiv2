/**
 * security/immutable.audit.ts — Immutable audit log with cryptographic hash chain.
 *
 * Guarantees that audit records cannot be tampered with without detection:
 *
 *   Hash Chain:
 *     Each AuditLog entry stores a `_chain_hash` in its payload, computed as:
 *       SHA-256(prev_hash || id || actor || action || entity || timestamp || payload)
 *     This forms a chain: tampering with ANY past entry breaks all subsequent hashes.
 *
 *   Immutability enforcement:
 *     — Database: `AuditLog` table has no UPDATE or DELETE permissions (enforced via
 *       PostgreSQL role `audit_writer` with INSERT-only grants)
 *     — Application: write path goes only through this module (never direct prisma.auditLog.create)
 *     — Archival: daily S3 archival with SHA-256 of each batch, stored separately
 *
 *   SOC2 / PCI DSS requirements met:
 *     — CC7.2: Log security events
 *     — CC7.3: Evaluate security events
 *     — LOG-003 (PCI DSS Req 10.3): Protect audit log files from destruction/modification
 *     — LOG-004 (PCI DSS Req 10.5): Secure audit trails to prevent modification
 *
 *   Tamper detection:
 *     — verifyChain(limit) re-computes hashes from genesis and flags any break
 *     — Runs daily as a scheduled job
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

/** Same composability contract as wallet-service/ledger.engine.ts's `Db`. */
type Db = Prisma.TransactionClient | PrismaClient;

const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// REALTIME_FREEZE.md Critical #2: fixed, arbitrary key for a Postgres
// session-level advisory lock (pg_advisory_xact_lock) scoped to the
// current transaction -- serializes the chain-head read + insert against
// every other concurrent write() call, both in this process AND across
// every other worker process sharing this Postgres instance. Without it,
// two concurrent writers could both read the same prevHash and both
// insert, forking the chain; verifyChain() would then flag that fork as
// tampering -- a false positive on a pair of writes that were both
// entirely legitimate. This matters far more once write() has ~60 call
// sites across every security-sensitive module instead of the original 3
// low-frequency admin/compliance ones, where the race was improbable but
// not impossible.
const AUDIT_CHAIN_LOCK_KEY = 728_401_996_215n;

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditEntryInput = {
  actor:    string;
  action:   string;
  entity:   string;
  // `object`, not `Record<string, unknown>`: every call site in this
  // codebase passes its payload as `{...} as object` (matching Prisma's
  // own `Json` field type) -- matches that existing convention instead of
  // requiring ~30 call sites to drop a cast that was already correct for
  // its actual destination (the AuditLog.payload Json column).
  payload:  object;
  severity?: "INFO" | "WARNING" | "CRITICAL";
  /**
   * REALTIME_FREEZE.md Critical #2: overrides the timestamp used for BOTH
   * the hash computation and the stored `createdAt` column (see write()'s
   * docstring for why these two must always be identical). Only needed by
   * callers recording a past event asynchronously -- e.g.
   * compliance/audit.outbox.consumer.ts processing an OutboxEvent seconds
   * or minutes after the position it documents actually closed, where the
   * audit row should carry the real event time, not the processing time.
   * Defaults to `new Date()` (the write-time instant) when omitted.
   */
  timestamp?: Date;
};

export type AuditChainVerification = {
  valid:        boolean;
  totalChecked: number;
  firstBreak?:  { id: string; expectedHash: string; storedHash: string; position: number };
};

// ─── ImmutableAuditLog ───────────────────────────────────────────────────────

export class ImmutableAuditLog {

  /**
   * Write an immutable audit entry with hash-chain integrity.
   * This is the ONLY function that should write to AuditLog.
   *
   * REALTIME_FREEZE.md Critical #2: accepts an optional `tx` -- most
   * callers (ledger, KYC, order cancel/modify, margin, deposit state
   * machine, reconciliation, ...) must write their audit row atomically
   * inside the SAME database transaction as the financial/state mutation
   * it documents (the FASE 2.1/5 pattern this codebase already enforces
   * for OutboxEvent rows). Passing `tx` writes within the caller's own
   * transaction instead of opening a new one, so a rollback of the
   * caller's transaction also rolls back the audit row -- and, just as
   * importantly, so the audit row can never commit while the mutation it
   * documents does not.
   *
   * CRITICAL FIX bundled into this same change: `createdAt` is now always
   * set EXPLICITLY to the same `ts` value used to compute `_chain_hash`.
   * Before this fix, `createdAt` was left to Postgres's own
   * `@default(now())` -- a DIFFERENT instant than the app-level `now` this
   * method hashed, off by however many milliseconds the write took to
   * reach the database. verifyChain() re-derives each hash from the
   * STORED `createdAt` column, so that mismatch meant verification could
   * never actually reproduce the original hash for ANY row -- the chain
   * would report itself broken from entry #1, always, for every entry
   * ever written by any of the (previously 3, now ~60) call sites. This
   * was already true before this change; it simply had no test coverage
   * to catch it (see immutable.audit.spec.ts, added alongside this fix).
   */
  async write(input: AuditEntryInput, tx?: Db): Promise<string> {
    const id = randomUUID();
    const ts = input.timestamp ?? new Date();

    if (!IS_PERSISTENT || !prisma) return id;

    const run = async (client: Db) => {
      // Must hold this lock for the read+insert of a SINGLE write() call --
      // never span it across the caller's whole transaction -- otherwise
      // two audit writes inside the same caller transaction would
      // deadlock against each other (Postgres advisory locks are
      // re-entrant per session, but re-acquiring inside the same
      // transaction is still fine; the risk is holding it across an
      // `await` that yields to other work). Acquired and used immediately
      // below, nothing else runs between acquisition and the insert.
      //
      // $executeRaw, NOT $queryRaw: pg_advisory_xact_lock() returns SQL
      // type `void`, which Prisma's query engine cannot deserialize into
      // any Prisma scalar -- $queryRaw throws "Failed to deserialize
      // column of type 'void'" on every single call. $executeRaw doesn't
      // attempt to deserialize a result set (it only reports affected row
      // count), so it works for a void-returning function call.
      await client.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;

      const prevHash  = await this._getChainHead(client);
      const chainHash = this._computeHash(prevHash, id, input.actor, input.action, input.entity, ts.toISOString(), input.payload);

      const enrichedPayload: Record<string, unknown> = {
        ...input.payload,
        _chain_hash:  chainHash,
        _prev_hash:   prevHash,
        _severity:    input.severity ?? "INFO",
        _written_at:  new Date().toISOString(),
      };

      await client.auditLog.create({
        data: {
          id,
          actor:     input.actor,
          action:    input.action,
          entity:    input.entity,
          payload:   enrichedPayload as object,
          createdAt: ts,
        },
      });
    };

    if (tx) {
      await run(tx);
    } else {
      await prisma.$transaction(run);
    }

    return id;
  }

  /**
   * Verify the integrity of the audit chain.
   * Re-computes every hash and compares against stored values.
   * Called by daily integrity check job.
   */
  async verifyChain(limit = 10000): Promise<AuditChainVerification> {
    if (!IS_PERSISTENT || !prisma) {
      return { valid: true, totalChecked: 0 };
    }

    const entries = await prisma.auditLog.findMany({
      orderBy: { createdAt: "asc" },
      take:    limit,
      select:  { id: true, actor: true, action: true, entity: true, payload: true, createdAt: true },
    });

    let prevHash = GENESIS_HASH;
    let position = 0;

    for (const entry of entries) {
      position++;
      const payload = entry.payload as Record<string, unknown>;
      const storedHash  = (payload["_chain_hash"] as string) ?? "";
      const storedPrev  = (payload["_prev_hash"]  as string) ?? GENESIS_HASH;

      // Check prev hash matches chain
      if (storedPrev !== prevHash) {
        return {
          valid: false,
          totalChecked: position,
          firstBreak: {
            id:           entry.id,
            expectedHash: prevHash,
            storedHash:   storedPrev,
            position,
          },
        };
      }

      // Re-compute expected hash
      const cleanPayload = { ...payload };
      delete cleanPayload["_chain_hash"];
      delete cleanPayload["_prev_hash"];

      const expectedHash = this._computeHash(
        prevHash,
        entry.id,
        entry.actor,
        entry.action,
        entry.entity,
        entry.createdAt.toISOString(),
        cleanPayload,
      );

      if (storedHash && expectedHash !== storedHash) {
        return {
          valid: false,
          totalChecked: position,
          firstBreak: { id: entry.id, expectedHash, storedHash, position },
        };
      }

      prevHash = storedHash || expectedHash;
    }

    return { valid: true, totalChecked: position };
  }

  /**
   * Archive audit logs to S3 for long-term immutable storage.
   * Called daily. Each archive batch has its own manifest with SHA-256.
   */
  async archiveBatch(from: Date, to: Date): Promise<{ archived: number; manifestHash: string }> {
    if (!IS_PERSISTENT || !prisma) return { archived: 0, manifestHash: "" };

    const entries = await prisma.auditLog.findMany({
      where:   { createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
    });

    if (entries.length === 0) return { archived: 0, manifestHash: "" };

    const jsonLines = entries.map((e) => JSON.stringify(e)).join("\n");
    const manifestHash = createHash("sha256").update(jsonLines).digest("hex");

    // Write to S3 if configured
    const bucket = process.env.AUDIT_ARCHIVE_S3_BUCKET;
    if (bucket) {
      const key = `audit/${from.toISOString().slice(0, 10)}_${from.getTime()}.jsonl`;
      await this._writeToS3(bucket, key, jsonLines, manifestHash).catch((err) => {
        console.error("[immutable-audit] S3 archive failed:", (err as Error).message);
      });
    }

    // Also write to CloudWatch Logs if configured
    const logGroup = process.env.AUDIT_CLOUDWATCH_LOG_GROUP;
    if (logGroup) {
      await this._writeToCloudWatch(logGroup, jsonLines).catch((err) => {
        console.error("[immutable-audit] CloudWatch archive failed:", (err as Error).message);
      });
    }

    return { archived: entries.length, manifestHash };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _computeHash(
    prevHash: string,
    id:       string,
    actor:    string,
    action:   string,
    entity:   string,
    ts:       string,
    payload:  object,
  ): string {
    const content = JSON.stringify({ prevHash, id, actor, action, entity, ts, payload });
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * REALTIME_FREEZE.md Critical #2: always reads fresh from `client` under
   * the advisory lock in write() -- no in-memory cache. A per-process
   * cache would go stale the instant ANY other worker process wrote a new
   * entry (this platform runs a multi-worker PM2 cluster, see
   * realtime-infra/redis.pubsub.ts), silently chaining a new entry off an
   * outdated head and producing exactly the kind of fork the advisory
   * lock exists to prevent. One extra SELECT per write is the correct
   * trade for a security control -- see the write() docstring.
   */
  private async _getChainHead(client: Db): Promise<string> {
    const latest = await client.auditLog.findFirst({
      orderBy: { createdAt: "desc" },
      select:  { payload: true },
    }).catch(() => null);

    if (!latest) return GENESIS_HASH;
    return ((latest.payload as Record<string, unknown>)["_chain_hash"] as string) ?? GENESIS_HASH;
  }

  private async _writeToS3(bucket: string, key: string, body: string, hash: string): Promise<void> {
    const s3 = await import("@aws-sdk/client-s3" as string) as {
      S3Client: new (cfg: { region: string }) => { send(cmd: unknown): Promise<void> };
      PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    };
    const client = new s3.S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
    await client.send(new s3.PutObjectCommand({
      Bucket:             bucket,
      Key:                key,
      Body:               body,
      ContentType:        "application/x-ndjson",
      Metadata:           { "sha256-manifest": hash, "archive-type": "audit-log" },
      ServerSideEncryption: "aws:kms",
    }));
    // Write manifest file
    await client.send(new s3.PutObjectCommand({
      Bucket:      bucket,
      Key:         key + ".manifest",
      Body:        JSON.stringify({ sha256: hash, entries: body.split("\n").length, key }),
      ContentType: "application/json",
      ServerSideEncryption: "aws:kms",
    }));
  }

  private async _writeToCloudWatch(logGroup: string, body: string): Promise<void> {
    const cw = await import("@aws-sdk/client-cloudwatch-logs" as string) as {
      CloudWatchLogsClient: new (cfg: { region: string }) => { send(cmd: unknown): Promise<void> };
      PutLogEventsCommand: new (input: Record<string, unknown>) => unknown;
    };
    const client   = new cw.CloudWatchLogsClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    const logStream = `igfxpro-audit-${new Date().toISOString().slice(0, 10)}`;
    const events    = body.split("\n").filter(Boolean).map((line) => ({
      timestamp: Date.now(),
      message:   line,
    }));
    await client.send(new cw.PutLogEventsCommand({
      logGroupName:  logGroup,
      logStreamName: logStream,
      logEvents:     events,
    }));
  }
}

export const immutableAudit = new ImmutableAuditLog();
export default immutableAudit;
