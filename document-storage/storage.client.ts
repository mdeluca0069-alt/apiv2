import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageConfig } from "./storage.config.js";

export type UploadOptions = {
  metadata?:   Record<string, string>;
  // Forces AES256 SSE even when no KMS key is configured (default: true)
  serverSideEncryption?: boolean;
};

export type UploadResult = {
  key:       string;
  bucket:    string;
  etag:      string;
  versionId?: string;
};

export type PresignedResult = {
  url:       string;
  expiresAt: Date;
};

export class StorageClient {
  private s3:      S3Client;
  private bucket:  string;
  private kmsKeyId?: string;
  private provider: string;

  constructor(config: StorageConfig) {
    this.bucket   = config.bucket;
    this.kmsKeyId = config.kmsKeyId;
    this.provider = config.provider;

    this.s3 = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId:     config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint
        ? {
            endpoint:      config.endpoint,
            // R2 requires path-style to be false (virtual-hosted style)
            forcePathStyle: false,
          }
        : {}),
    });
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  async upload(
    key:      string,
    body:     Buffer,
    mimeType: string,
    opts:     UploadOptions = {},
  ): Promise<UploadResult> {
    const sse = opts.serverSideEncryption !== false;

    const cmd = new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         key,
      Body:        body,
      ContentType: mimeType,
      Metadata:    opts.metadata ?? {},
      // SSE-KMS when key provided (S3 only), otherwise SSE-S3 (AES256)
      // R2 handles encryption transparently; sending SSE headers is harmless.
      ...(sse && this.kmsKeyId
        ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.kmsKeyId }
        : sse
          ? { ServerSideEncryption: "AES256" }
          : {}),
    });

    const result = await this.s3.send(cmd);
    return {
      key,
      bucket:    this.bucket,
      etag:      result.ETag ?? "",
      versionId: result.VersionId,
    };
  }

  // ── Presigned PUT (client → storage direct upload) ──────────────────────────

  async presignedPut(
    key:        string,
    mimeType:   string,
    ttlSeconds: number = 300,
  ): Promise<PresignedResult> {
    const cmd = new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         key,
      ContentType: mimeType,
    });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: ttlSeconds });
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  // ── Presigned GET (secure time-limited download) ────────────────────────────

  async presignedGet(
    key:                  string,
    ttlSeconds:           number = 900,
    responseDisposition?: string,
  ): Promise<PresignedResult> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key:    key,
      ...(responseDisposition ? { ResponseContentDisposition: responseDisposition } : {}),
    });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: ttlSeconds });
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  // ── Server-to-server move (quarantine → active) ──────────────────────────────

  async move(sourceKey: string, destKey: string): Promise<void> {
    await this.s3.send(new CopyObjectCommand({
      Bucket:     this.bucket,
      CopySource: `${this.bucket}/${encodeURIComponent(sourceKey)}`,
      Key:        destKey,
      // Preserve SSE on copy
      ...(this.kmsKeyId
        ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: this.kmsKeyId }
        : { ServerSideEncryption: "AES256" as const }),
    }));
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sourceKey }));
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  get bucketName(): string {
    return this.bucket;
  }

  get providerName(): string {
    return this.provider;
  }
}
