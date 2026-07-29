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
  // CRITICAL_REMEDIATION (C5): our own DepositTransaction id, when the PSP's
  // webhook echoes it back (Nuvei: merchant_unique_id, Praxis: order_id).
  // processWebhookConfirmation() correlates on this first, falling back to
  // pspRef -- see nuvei.adapter.ts's parseWebhook() docstring for why pspRef
  // alone is not reliable for every PSP.
  depositId?: string;
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
