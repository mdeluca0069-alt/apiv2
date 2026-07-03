export type PspName = "STRIPE" | "NUVEI" | "PRAXIS";

export type CreateSessionInput = {
  depositId:   string;
  userId:      string;
  amount:      number;
  currency:    string;
  returnUrl:   string;
  webhookUrl:  string;
};

export type CreateSessionResult = {
  sessionId:   string;
  redirectUrl: string;
  pspRef?:     string;
};

export type WebhookParseResult = {
  pspRef:    string;
  status:    "CONFIRMED" | "FAILED";
  amount?:   number;
  currency?: string;
  failReason?: string;
};

export interface PspAdapter {
  readonly name: PspName;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookParseResult>;
}

// ─── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<PspName, PspAdapter>();

export function registerPsp(adapter: PspAdapter): void {
  registry.set(adapter.name, adapter);
}

export function getPsp(name: PspName): PspAdapter {
  const a = registry.get(name);
  if (!a) throw new Error(`PSP_NOT_CONFIGURED:${name}`);
  return a;
}

export function listPsps(): PspName[] {
  return [...registry.keys()];
}
