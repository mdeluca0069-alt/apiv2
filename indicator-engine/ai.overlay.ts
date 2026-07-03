export type AiOverlayResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createAiOverlay(): AiOverlayResult {
  return {
    module: "Ai Overlay",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const AiOverlay = createAiOverlay();

export default AiOverlay;
