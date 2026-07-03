export type RequestLoggerResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createRequestLogger(): RequestLoggerResult {
  return {
    module: "Request Logger",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const RequestLogger = createRequestLogger();

export default RequestLogger;
