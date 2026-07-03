export type OrderbookStreamResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createOrderbookStream(): OrderbookStreamResult {
  return {
    module: "Orderbook Stream",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const OrderbookStream = createOrderbookStream();

export default OrderbookStream;
