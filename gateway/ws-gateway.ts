export type WsGatewayResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createWsGateway(): WsGatewayResult {
  return {
    module: "Ws Gateway",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const WsGateway = createWsGateway();

export default WsGateway;
