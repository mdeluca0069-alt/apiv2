export type TenantMiddlewareResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createTenantMiddleware(): TenantMiddlewareResult {
  return {
    module: "Tenant Middleware",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const TenantMiddleware = createTenantMiddleware();

export default TenantMiddleware;
