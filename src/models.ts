export type ModelConfigKey = "model" | "model_reasoning_effort";

export type ModelConfigSnapshot = {
  model: string | null;
  reasoningEffort: string | null;
  provider: string | null;
  serviceTier: string | null;
};

export type CodexModelInfo = {
  id: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  isDefault: boolean;
};

export function findModel(
  models: CodexModelInfo[],
  input: string,
): CodexModelInfo | undefined {
  const wanted = input.trim().toLowerCase();
  if (!wanted) return undefined;
  return models.find(
    (model) =>
      model.id.toLowerCase() === wanted ||
      model.displayName.toLowerCase() === wanted,
  );
}

export function reasoningEffortFor(
  model: CodexModelInfo,
  input: string,
): string | undefined {
  const wanted = input.trim().toLowerCase();
  return model.supportedReasoningEfforts.find(
    (effort) => effort.toLowerCase() === wanted,
  );
}
