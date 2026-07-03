export type SanctionsCheckResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createSanctionsCheck(): SanctionsCheckResult {
  return {
    module: "Sanctions Check",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const SanctionsCheck = createSanctionsCheck();

export default SanctionsCheck;
