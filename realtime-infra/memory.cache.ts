export type MemoryCacheResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createMemoryCache(): MemoryCacheResult {
  return {
    module: "Memory Cache",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const MemoryCache = createMemoryCache();

export default MemoryCache;
