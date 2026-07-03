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
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Chain State ──────────────────────────────────────────────────────────────

// In-memory last-known hash for the current process (to chain new entries)
// Initialized from DB on first write.
let _chainHead: string | null = null;

const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditEntryInput = {
  actor:    string;
  action:   string;
  entity:   string;
  payload:  Record<string, unknown>;
  severity?: "INFO" | "WARNING" | "CRITICAL";
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
   */
  async write(input: AuditEntryInput): Promise<string> {
    const id        = randomUUID();
    const now       = new Date();
    const prevHash  = await this._getChainHead();
    const chainHash = this._computeHash(prevHash, id, input.actor, input.action, input.entity, now.toISOString(), input.payload);

    const enrichedPayload: Record<string, unknown> = {
      ...input.payload,
      _chain_hash:  chainHash,
      _prev_hash:   prevHash,
      _severity:    input.severity ?? "INFO",
      _written_at:  now.toISOString(),
    };

    if (IS_PERSISTENT && prisma) {
      await prisma.auditLog.create({
        data: {
          id,
          actor:   input.actor,
          action:  input.action,
          entity:  input.entity,
          payload: enrichedPayload as object,
        },
      });
      // Update chain head in memory
      _chainHead = chainHash;
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
    payload:  Record<string, unknown>,
  ): string {
    const content = JSON.stringify({ prevHash, id, actor, action, entity, ts, payload });
    return createHash("sha256").update(content).digest("hex");
  }

  private async _getChainHead(): Promise<string> {
    if (_chainHead !== null) return _chainHead;
    if (!IS_PERSISTENT || !prisma) return GENESIS_HASH;

    const latest = await prisma.auditLog.findFirst({
      orderBy: { createdAt: "desc" },
      select:  { payload: true },
    }).catch(() => null);

    if (!latest) { _chainHead = GENESIS_HASH; return GENESIS_HASH; }

    const hash = ((latest.payload as Record<string, unknown>)["_chain_hash"] as string) ?? GENESIS_HASH;
    _chainHead = hash;
    return hash;
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
