export type OrderValidatorResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createOrderValidator(): OrderValidatorResult {
  return {
    module: "Order Validator",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const OrderValidator = createOrderValidator();

export default OrderValidator;
