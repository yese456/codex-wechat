import type { Attachment } from "../media/types.js";
import type { CodexModelInfo, ModelConfigSnapshot } from "../models.js";

export type HostKind = "local" | "http";

export type PendingApprovalView = {
  shortCode: string;
  summary: string;
};

/** Unified backend: local Codex or remote agent HTTP. */
export interface CodexHost {
  readonly id: string;
  readonly label: string;
  readonly kind: HostKind;

  statusText(): Promise<string>;
  usageText(): Promise<string>;
  getModelConfig(): Promise<ModelConfigSnapshot>;
  listModels(): Promise<CodexModelInfo[]>;
  setModel(modelId: string): Promise<ModelConfigSnapshot>;
  setReasoningEffort(effort: string): Promise<ModelConfigSnapshot>;
  getCwd(): Promise<string>;
  setCwd(path: string): Promise<string>;
  newThread(title?: string): Promise<string>;
  listSessions(): Promise<string>;
  useSession(arg: string): Promise<string>;
  /**
   * Run a user turn. For remote hosts, may call onApproval while waiting.
   */
  runPrompt(
    text: string,
    attachments: Attachment[],
    hooks?: {
      onApproval?: (a: PendingApprovalView) => void | Promise<void>;
    },
  ): Promise<string>;
  listApprovalsText(): Promise<string>;
  resolveApproval(
    code: string,
    decision: "accept" | "decline",
  ): Promise<string>;
  getFile(
    path: string,
  ): Promise<{ fileName: string; data: Buffer; isImage: boolean }>;
  /** Optional connectivity check */
  ping(): Promise<boolean>;
}
