import type { Attachment } from "../media/types.js";
import type { CompletionEvent } from "../completions/types.js";
import type { CodexModelInfo, ModelConfigSnapshot } from "../models.js";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "../config.js";

export type HostKind = "local" | "http";

export type PendingApprovalView = {
  shortCode: string;
  summary: string;
};

export type SecurityPolicySnapshot = {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
};

export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  current: boolean;
};

/** Invalid user-controlled host setting; HTTP agents map this to 400. */
export class HostInputError extends Error {}

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
  getSecurityPolicy(): Promise<SecurityPolicySnapshot>;
  setSandboxMode(mode: CodexSandboxMode): Promise<SecurityPolicySnapshot>;
  setApprovalPolicy(
    policy: CodexApprovalPolicy,
  ): Promise<SecurityPolicySnapshot>;
  getCwd(): Promise<string>;
  setCwd(path: string): Promise<string>;
  listProjects(): Promise<ProjectInfo[]>;
  selectProject(selector: string): Promise<string>;
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
  /** Pending approvals (shortCode + summary) for this host, newest first. */
  listPendingApprovals(): Promise<PendingApprovalView[]>;
  resolveApproval(
    code: string,
    decision: "accept" | "decline",
  ): Promise<string>;
  getFile(
    path: string,
  ): Promise<{ fileName: string; data: Buffer; isImage: boolean }>;
  /** Optional connectivity check */
  ping(): Promise<boolean>;
  readonly completionNotificationsEnabled?: boolean;
  pollCompletions?(limit: number): Promise<CompletionEvent[]>;
  ackCompletions?(ids: string[]): Promise<void>;
}
