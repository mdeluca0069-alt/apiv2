export type OrderPriorityResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createOrderPriority(): OrderPriorityResult {
  return {
    module: "Order Priority",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const OrderPriority = createOrderPriority();

export default OrderPriority;
