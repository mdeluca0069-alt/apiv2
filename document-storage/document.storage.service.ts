import { randomUUID }             from "node:crypto";
import { prisma, IS_PERSISTENT }   from "../shared/db.js";
import { StorageClient }            from "./storage.client.js";
import { StorageEncryption }        from "./storage.encryption.js";
import { VirusScanHook }            from "./virus-scan.hook.js";
import { retentionPolicyEngine }    from "./retention.policy.js";
import type { RetentionPolicyName } from "./retention.policy.js";
import type { ScanCallbackPayload } from "./virus-scan.hook.js";
import { loadStorageConfig, isStorageConfigured } from "./storage.config.js";
import { eventBus }                 from "../events-bus/event.bus.js";
import { immutableAudit }           from "../security/immutable.audit.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DocumentCategory =
  | "KYC_DOCUMENT"
  | "COMPLIANCE"
  | "TRADE_EVIDENCE"
  | "SUPPORT_ATTACHMENT"
  | "TEMP";

export type DocumentStatus =
  | "QUARANTINE"    // uploaded, awaiting scan
  | "SCANNING"      // scan in progress
  | "ACTIVE"        // scan passed, available
  | "INFECTED"      // scan found threats — deleted from storage
  | "DELETED";      // soft-deleted by user/admin

export type ScanStatus = "PENDING" | "SCANNING" | "CLEAN" | "INFECTED" | "SKIPPED" | "ERROR";

export type InitiateUploadInput = {
  userId:    string;
  fileName:  string;
  mimeType:  string;
  sizeBytes: number;
  category:  DocumentCategory;
  retention?: RetentionPolicyName;
  metadata?:  Record<string, string>;
};

export type InitiateUploadResult = {
  documentId:        string;
  presignedPutUrl:   string;
  storageKey:        string;     // quarantine key the client must PUT to
  expiresAt:         string;
};

export type DirectUploadInput = {
  userId:    string;
  fileName:  string;
  mimeType:  string;
  category:  DocumentCategory;
  content:   string;             // base64 (with or without data-URI prefix)
  retention?: RetentionPolicyName;
  metadata?:  Record<string, string>;
  kycDocumentId?: string;
};

export type DocumentRecord = {
  id:               string;
  userId:           string;
  category:         string;
  fileName:         string;
  mimeType:         string;
  sizeBytes:        number;
  storageKey:       string;
  storageProvider:  string;
  scanStatus:       string;
  status:           string;
  retentionPolicy:  string;
  retentionUntil:   string | null;
  kycDocumentId?:   string | null;
  uploadedAt:       string;
};

export type PresignedDownloadResult = {
  url:       string;
  expiresAt: string;
  fileName:  string;
  mimeType:  string;
};

// ── Lazy singleton ─────────────────────────────────────────────────────────────

let _client:     StorageClient     | null = null;
let _encryption: StorageEncryption | null = null;
let _scanner:    VirusScanHook     | null = null;
let _configured = false;

function getClients(): {
  client:     StorageClient;
  encryption: StorageEncryption;
  scanner:    VirusScanHook;
} {
  if (!_configured) {
    if (!isStorageConfigured()) {
      throw Object.assign(
        new Error("Document storage is not configured. Set STORAGE_PROVIDER and provider credentials in .env"),
        { statusCode: 503 },
      );
    }
    const cfg = loadStorageConfig();
    _client     = new StorageClient(cfg);
    _encryption = new StorageEncryption(cfg.masterKeyHex);
    _scanner    = new VirusScanHook(cfg.virusScanUrl, cfg.virusScanToken, cfg.publicBaseUrl);
    _configured = true;
  }
  return {
    client:     _client!,
    encryption: _encryption!,
    scanner:    _scanner!,
  };
}

// ── Key helpers ───────────────────────────────────────────────────────────────

function quarantineKey(documentId: string): string {
  return `quarantine/${documentId}`;
}

function activeKey(userId: string, documentId: string, category: string): string {
  return `documents/${category.toLowerCase()}/${userId}/${documentId}`;
}

function parseBase64Content(content: string): Buffer {
  // Strip optional data-URI prefix: "data:image/jpeg;base64,..."
  const comma = content.indexOf(",");
  const raw   = comma !== -1 ? content.slice(comma + 1) : content;
  return Buffer.from(raw, "base64");
}

// ── DocumentStorageService ────────────────────────────────────────────────────

export class DocumentStorageService {

  // ── 1. Initiate presigned upload (large files — client → storage direct) ────

  async initiateUpload(input: InitiateUploadInput): Promise<InitiateUploadResult> {
    const { client } = getClients();
    const id = randomUUID();

    const policy     = input.retention ?? retentionPolicyEngine.defaultForCategory(input.category);
    const expiresAt  = retentionPolicyEngine.computeExpiresAt(policy);
    const qKey       = quarantineKey(id);

    const presigned = await client.presignedPut(qKey, input.mimeType, 300);

    if (IS_PERSISTENT) {
      await prisma!.storedDocument.create({
        data: {
          id,
          userId:          input.userId,
          category:        input.category,
          fileName:        input.fileName,
          mimeType:        input.mimeType,
          sizeBytes:       input.sizeBytes,
          storageKey:      qKey,
          storageBucket:   client.bucketName,
          storageProvider: client.providerName,
          scanStatus:      "PENDING",
          status:          "QUARANTINE",
          retentionPolicy: policy,
          retentionUntil:  expiresAt,
          metadata:        (input.metadata ?? {}) as object,
        },
      });
    }

    return {
      documentId:      id,
      presignedPutUrl: presigned.url,
      storageKey:      qKey,
      expiresAt:       presigned.expiresAt.toISOString(),
    };
  }

  // ── 2. Confirm upload (after client PUT to presigned URL) ─────────────────

  async confirmUpload(documentId: string, userId: string): Promise<DocumentRecord> {
    const { client, scanner } = getClients();

    const doc = await this._requireDoc(documentId, userId);
    if (doc.status !== "QUARANTINE") {
      throw Object.assign(new Error("Document is not in quarantine"), { statusCode: 409 });
    }

    if (!(await client.exists(doc.storageKey))) {
      throw Object.assign(
        new Error("File not found in quarantine — upload the file to the presigned URL first"),
        { statusCode: 422 },
      );
    }

    if (scanner.enabled) {
      await scanner.triggerScan({
        documentId,
        storageKey: doc.storageKey,
        bucket:     doc.storageBucket,
        fileName:   doc.fileName,
        mimeType:   doc.mimeType,
        sizeBytes:  doc.sizeBytes,
      });

      if (IS_PERSISTENT) {
        await prisma!.storedDocument.update({
          where: { id: documentId },
          data:  { scanStatus: "SCANNING" },
        });
      }
    } else {
      // No scanner configured — move immediately to active
      await this._activateDocument(documentId, doc.storageKey, doc.userId, doc.category, client);
    }

    return this._toRecord(await this._requireDoc(documentId, userId));
  }

  // ── 3. Direct upload (base64 body — small files, KYC compat) ───────────────

  async directUpload(input: DirectUploadInput): Promise<DocumentRecord> {
    const { client, encryption, scanner } = getClients();
    const id = randomUUID();

    const plaintext  = parseBase64Content(input.content);
    const policy     = input.retention ?? retentionPolicyEngine.defaultForCategory(input.category);
    const expiresAt  = retentionPolicyEngine.computeExpiresAt(policy);

    // Client-side envelope encrypt if master key is configured
    let uploadBody:   Buffer;
    let encryptedDek: string | null = null;

    if (encryption.isConfigured) {
      const result = encryption.encrypt(plaintext);
      uploadBody   = result.ciphertext;
      encryptedDek = result.encryptedDek;
    } else {
      uploadBody = plaintext;
    }

    const qKey = quarantineKey(id);
    await client.upload(qKey, uploadBody, input.mimeType, {
      metadata: {
        ...(input.metadata ?? {}),
        documentId: id,
        userId:     input.userId,
        encrypted:  encryptedDek ? "true" : "false",
      },
    });

    if (IS_PERSISTENT) {
      await prisma!.storedDocument.create({
        data: {
          id,
          userId:          input.userId,
          category:        input.category,
          fileName:        input.fileName,
          mimeType:        input.mimeType,
          sizeBytes:       plaintext.byteLength,
          storageKey:      qKey,
          storageBucket:   client.bucketName,
          storageProvider: client.providerName,
          encryptedDek,
          scanStatus:      "PENDING",
          status:          "QUARANTINE",
          retentionPolicy: policy,
          retentionUntil:  expiresAt,
          kycDocumentId:   input.kycDocumentId ?? null,
          metadata:        (input.metadata ?? {}) as object,
        },
      });
    }

    if (scanner.enabled) {
      await scanner.triggerScan({
        documentId: id,
        storageKey: qKey,
        bucket:     client.bucketName,
        fileName:   input.fileName,
        mimeType:   input.mimeType,
        sizeBytes:  plaintext.byteLength,
      });

      if (IS_PERSISTENT) {
        await prisma!.storedDocument.update({
          where: { id },
          data:  { scanStatus: "SCANNING" },
        });
      }
    } else {
      // Immediately move to active when no scanner is configured
      await this._activateDocument(id, qKey, input.userId, input.category, client);
    }

    if (!IS_PERSISTENT) {
      return this._syntheticRecord(id, input, qKey, policy, expiresAt, client);
    }
    const row = await prisma!.storedDocument.findUnique({ where: { id } });
    return this._toRecord(row!);
  }

  // ── 4. Handle virus scan callback (webhook) ──────────────────────────────────

  async handleScanResult(rawPayload: unknown): Promise<void> {
    const { client, scanner } = getClients();
    const result: ScanCallbackPayload = scanner.parseScanCallback(rawPayload);
    const { documentId, status, threats, scannedAt, scanner: scannerName } = result;

    if (!IS_PERSISTENT) return;

    const doc = await prisma!.storedDocument.findUnique({ where: { id: documentId } });
    if (!doc) {
      console.warn(`[document-storage] scan-result for unknown doc: ${documentId}`);
      return;
    }

    if (status === "CLEAN") {
      await this._activateDocument(documentId, doc.storageKey, doc.userId, doc.category, client);
      await prisma!.storedDocument.update({
        where: { id: documentId },
        data:  {
          scanStatus: "CLEAN",
          scanResult: { status, scannedAt, scanner: scannerName } as object,
          scannedAt:  new Date(scannedAt),
        },
      });

      eventBus.emit("document.scan_clean", { documentId, userId: doc.userId });

    } else if (status === "INFECTED") {
      // Delete from storage immediately — never serve infected files
      await client.delete(doc.storageKey).catch((err) => {
        console.error(`[document-storage] failed to delete infected file ${doc.storageKey}:`, err);
      });

      await prisma!.storedDocument.update({
        where: { id: documentId },
        data:  {
          status:     "INFECTED",
          scanStatus: "INFECTED",
          scanResult: { status, threats, scannedAt, scanner: scannerName } as object,
          scannedAt:  new Date(scannedAt),
        },
      });

      eventBus.emit("document.scan_infected", {
        documentId, userId: doc.userId, threats, scannedAt,
      });

      // FASE 7 CLOSURE, Phase A (L.3, re-evaluated): a malware-positive scan
      // is genuinely security-relevant -- unlike the archive-only fix for
      // the rest of this finding, this specific event deserves the
      // tamper-evident hash chain, not just the append-only archive.
      await immutableAudit.write({
        actor:   "VIRUS_SCAN",
        action:  "document.scan_infected",
        entity:  documentId,
        payload: { userId: doc.userId, threats, scannedAt } as object,
        severity: "CRITICAL",
      });

      console.warn(`[document-storage] INFECTED file detected — deleted: ${documentId} threats:`, threats);

    } else {
      // ERROR — leave in quarantine, mark for retry
      await prisma!.storedDocument.update({
        where: { id: documentId },
        data:  {
          scanStatus: "ERROR",
          scanResult: { status, scannedAt, scanner: scannerName } as object,
          scannedAt:  new Date(scannedAt),
        },
      });
    }
  }

  // ── 5. Presigned download URL ────────────────────────────────────────────────

  async getDownloadUrl(
    documentId: string,
    userId:     string,
    ttlSeconds  = 900,
  ): Promise<PresignedDownloadResult> {
    const { client } = getClients();
    const doc = await this._requireDoc(documentId, userId);

    if (doc.status !== "ACTIVE") {
      throw Object.assign(
        new Error(`Document is not available (status: ${doc.status})`),
        { statusCode: 409 },
      );
    }

    const disposition = `attachment; filename="${encodeURIComponent(doc.fileName)}"`;
    const presigned   = await client.presignedGet(doc.storageKey, ttlSeconds, disposition);

    return {
      url:       presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
      fileName:  doc.fileName,
      mimeType:  doc.mimeType,
    };
  }

  // ── 6. Soft delete ──────────────────────────────────────────────────────────

  async deleteDocument(documentId: string, userId: string, adminOverride = false): Promise<void> {
    const { client } = getClients();

    const doc = await this._requireDoc(documentId, adminOverride ? undefined : userId);

    if (doc.status === "DELETED") {
      throw Object.assign(new Error("Document already deleted"), { statusCode: 409 });
    }

    await client.delete(doc.storageKey).catch(() => {
      // Best-effort — record may already be gone from storage
    });

    if (IS_PERSISTENT) {
      await prisma!.storedDocument.update({
        where: { id: documentId },
        data:  { status: "DELETED", deletedAt: new Date() },
      });
    }

    eventBus.emit("document.deleted", { documentId, userId: doc.userId });
  }

  // ── 7. List documents (user scope) ──────────────────────────────────────────

  async listForUser(userId: string, category?: string): Promise<DocumentRecord[]> {
    if (!IS_PERSISTENT) return [];

    const rows = await prisma!.storedDocument.findMany({
      where:   {
        userId,
        status:   { not: "DELETED" },
        ...(category ? { category } : {}),
      },
      orderBy: { uploadedAt: "desc" },
      take:    100,
    });

    return rows.map((r) => this._toRecord(r));
  }

  // ── 8. Admin: list all (with optional filters) ───────────────────────────────

  async adminList(opts: {
    status?:     string;
    scanStatus?: string;
    category?:   string;
    limit?:      number;
  } = {}): Promise<DocumentRecord[]> {
    if (!IS_PERSISTENT) return [];

    const rows = await prisma!.storedDocument.findMany({
      where: {
        ...(opts.status     ? { status:     opts.status }     : {}),
        ...(opts.scanStatus ? { scanStatus: opts.scanStatus } : {}),
        ...(opts.category   ? { category:   opts.category }   : {}),
      },
      orderBy: { uploadedAt: "desc" },
      take:    opts.limit ?? 100,
    });

    return rows.map((r) => this._toRecord(r));
  }

  // ── 9. Retention sweep (call from scheduler) ─────────────────────────────────

  async purgeExpiredDocuments(): Promise<number> {
    if (!IS_PERSISTENT) return 0;
    const { client } = getClients();

    const expired = await prisma!.storedDocument.findMany({
      where: {
        status:         { not: "DELETED" },
        retentionUntil: { lt: new Date() },
      },
      take: 200,
    });

    let count = 0;
    for (const doc of expired) {
      try {
        await client.delete(doc.storageKey);
        await prisma!.storedDocument.update({
          where: { id: doc.id },
          data:  { status: "DELETED", deletedAt: new Date() },
        });
        count++;
      } catch (err) {
        console.error(`[document-storage] failed to purge expired doc ${doc.id}:`, err);
      }
    }

    if (count > 0) {
      console.log(`[document-storage] retention sweep: purged ${count} expired documents`);
    }
    return count;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _activateDocument(
    documentId: string,
    currentKey: string,
    userId:     string,
    category:   string,
    client:     StorageClient,
  ): Promise<void> {
    const aKey = activeKey(userId, documentId, category);
    await client.move(currentKey, aKey);

    if (IS_PERSISTENT) {
      await prisma!.storedDocument.update({
        where: { id: documentId },
        data:  { status: "ACTIVE", storageKey: aKey, scanStatus: "CLEAN" },
      });
    }
  }

  private async _requireDoc(documentId: string, userId?: string): Promise<{
    id: string; userId: string; category: string; fileName: string; mimeType: string;
    sizeBytes: number; storageKey: string; storageBucket: string; storageProvider: string;
    scanStatus: string; status: string; retentionPolicy: string; retentionUntil: Date | null;
    kycDocumentId: string | null; uploadedAt: Date;
  }> {
    if (!IS_PERSISTENT) {
      throw Object.assign(new Error("Document storage requires a database connection"), { statusCode: 503 });
    }
    const doc = await prisma!.storedDocument.findUnique({ where: { id: documentId } });
    if (!doc) {
      throw Object.assign(new Error(`Document not found: ${documentId}`), { statusCode: 404 });
    }
    if (userId && doc.userId !== userId) {
      // Return 404 rather than 403 to avoid resource enumeration
      throw Object.assign(new Error(`Document not found: ${documentId}`), { statusCode: 404 });
    }
    return doc as typeof doc & { sizeBytes: number; storageBucket: string; storageProvider: string };
  }

  private _toRecord(doc: {
    id: string; userId: string; category: string; fileName: string; mimeType: string;
    sizeBytes: number; storageKey: string; storageProvider: string; scanStatus: string;
    status: string; retentionPolicy: string; retentionUntil: Date | null;
    kycDocumentId?: string | null; uploadedAt: Date;
  }): DocumentRecord {
    return {
      id:              doc.id,
      userId:          doc.userId,
      category:        doc.category,
      fileName:        doc.fileName,
      mimeType:        doc.mimeType,
      sizeBytes:       doc.sizeBytes,
      storageKey:      doc.storageKey,
      storageProvider: doc.storageProvider,
      scanStatus:      doc.scanStatus,
      status:          doc.status,
      retentionPolicy: doc.retentionPolicy,
      retentionUntil:  doc.retentionUntil?.toISOString() ?? null,
      kycDocumentId:   doc.kycDocumentId ?? null,
      uploadedAt:      doc.uploadedAt.toISOString(),
    };
  }

  private _syntheticRecord(
    id:       string,
    input:    DirectUploadInput,
    key:      string,
    policy:   RetentionPolicyName,
    expiresAt: Date | null,
    client:   StorageClient,
  ): DocumentRecord {
    return {
      id,
      userId:          input.userId,
      category:        input.category,
      fileName:        input.fileName,
      mimeType:        input.mimeType,
      sizeBytes:       0,
      storageKey:      key,
      storageProvider: client.providerName,
      scanStatus:      "SKIPPED",
      status:          "ACTIVE",
      retentionPolicy: policy,
      retentionUntil:  expiresAt?.toISOString() ?? null,
      kycDocumentId:   input.kycDocumentId ?? null,
      uploadedAt:      new Date().toISOString(),
    };
  }
}

export const documentStorageService = new DocumentStorageService();
