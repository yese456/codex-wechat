export type CompletionEvent = {
  id: string;
  threadId: string;
  turnId: string;
  cwd: string;
  requestSummary: string;
  resultSummary: string;
  createdAt: string;
};

export type CompletionCallbackConfig = {
  argv: string[];
  timeoutMs: number;
};

export type CompletionNotificationsConfig = {
  enabled: boolean;
  queuePath: string;
  deliveryPath: string;
  pollIntervalMs: number;
  batchSize: number;
  requestSummaryChars: number;
  resultSummaryChars: number;
  ackRetentionDays: number;
  callbacks: CompletionCallbackConfig[];
};

export type CompletionCapability = {
  enabled: boolean;
  pollCompletions(limit: number): Promise<CompletionEvent[]>;
  ackCompletions(ids: string[]): Promise<void>;
};
