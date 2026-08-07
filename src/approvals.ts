import type { CodexClient, PendingApproval } from "./codex/client.js";

export type ApprovalNotify = (approval: PendingApproval) => void | Promise<void>;

/**
 * Wire Codex approval events to a WeChat notifier.
 * Also handles timeout auto-deny.
 */
export class ApprovalBridge {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly codex: CodexClient,
    private readonly timeoutSec: number,
    private readonly notify: ApprovalNotify,
  ) {}

  attach(): void {
    const prev = this.codex.onEvent;
    this.codex.onEvent = (ev) => {
      prev?.(ev);
      if (ev.type === "approval") {
        void this.onApproval(ev.approval);
      }
      if (ev.type === "approvalResolved") {
        this.clearTimer(ev.approval.shortCode);
      }
    };
  }

  private async onApproval(approval: PendingApproval): Promise<void> {
    this.clearTimer(approval.shortCode);
    const timer = setTimeout(() => {
      void this.codex
        .resolveApproval(approval.shortCode, "decline")
        .catch(() => {});
    }, this.timeoutSec * 1000);
    timer.unref?.();
    this.timers.set(approval.shortCode, timer);
    try {
      await this.notify(approval);
    } catch (err) {
      console.error(
        `[approval] 通知失败，仍将在超时后自动拒绝 ${approval.shortCode}:`,
        (err as Error).message,
      );
    }
  }

  private clearTimer(code: string): void {
    const t = this.timers.get(code);
    if (t) {
      clearTimeout(t);
      this.timers.delete(code);
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
