export type StorageProvider = "S3" | "R2";

export type StorageConfig = {
  provider:          StorageProvider;
  bucket:            string;
  region:            string;
  endpoint?:         string;   // R2 custom endpoint
  accessKeyId:       string;
  secretAccessKey:   string;
  accountId?:        string;   // R2 account ID
  kmsKeyId?:         string;   // AWS KMS key ARN for SSE-KMS (S3 only)
  masterKeyHex:      string;   // 64 hex chars = 32 bytes for client-side AES-256-GCM
  virusScanEnabled:  boolean;
  virusScanUrl?:     string;
  virusScanToken?:   string;
  publicBaseUrl:     string;   // base URL for scan callback (e.g. https://api.igfxpro.com)
};

export function loadStorageConfig(): StorageConfig {
  const provider = (process.env.STORAGE_PROVIDER ?? "R2") as StorageProvider;

  if (provider === "R2") {
    const accountId = process.env.R2_ACCOUNT_ID;
    if (!accountId) {
      throw new Error("R2_ACCOUNT_ID is required when STORAGE_PROVIDER=R2");
    }
    return {
      provider:        "R2",
      bucket:          process.env.R2_BUCKET          ?? "igfxpro-documents",
      region:          "auto",
      endpoint:        `https://${accountId}.r2.cloudflarestorage.com`,
      accessKeyId:     process.env.R2_ACCESS_KEY_ID   ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
      accountId,
      masterKeyHex:      process.env.STORAGE_MASTER_KEY  ?? "",
      virusScanEnabled:  process.env.VIRUS_SCAN_ENABLED === "true",
      virusScanUrl:      process.env.VIRUS_SCAN_URL,
      virusScanToken:    process.env.VIRUS_SCAN_TOKEN,
      publicBaseUrl:     process.env.PUBLIC_API_URL     ?? "http://localhost:3000",
    };
  }

  // AWS S3
  return {
    provider:        "S3",
    bucket:          process.env.S3_BUCKET            ?? "igfxpro-documents",
    region:          process.env.AWS_REGION            ?? "us-east-1",
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID    ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    kmsKeyId:        process.env.AWS_KMS_KEY_ID,
    masterKeyHex:      process.env.STORAGE_MASTER_KEY  ?? "",
    virusScanEnabled:  process.env.VIRUS_SCAN_ENABLED === "true",
    virusScanUrl:      process.env.VIRUS_SCAN_URL,
    virusScanToken:    process.env.VIRUS_SCAN_TOKEN,
    publicBaseUrl:     process.env.PUBLIC_API_URL      ?? "http://localhost:3000",
  };
}

export function isStorageConfigured(): boolean {
  const provider = process.env.STORAGE_PROVIDER ?? "R2";
  if (provider === "R2") {
    return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
  }
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}
