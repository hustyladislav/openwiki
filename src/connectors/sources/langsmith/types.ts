export type LangSmithConfig = {
  allowOpenWikiProject?: boolean;
  apiUrl?: string;
  batchHours?: number;
  enabled?: boolean;
  excludeTags?: string[];
  includeCwdPrefixes?: string[];
  overlapHours?: number;
  projectId?: string;
  projectName?: string;
  startTime?: string;
};

export type LangSmithProjectIdentity = {
  id: string;
  name: string;
};

export type LangSmithRunRecord = {
  app_path?: string;
  completion_tokens?: number;
  end_time?: number | string;
  error?: string;
  extra?: Record<string, unknown>;
  id: string;
  inputs: Record<string, unknown>;
  name: string;
  outputs?: Record<string, unknown>;
  prompt_tokens?: number;
  run_type: string;
  start_time?: number | string;
  status?: string;
  tags?: string[];
  total_tokens?: number;
  trace_id?: string;
};

export type CompactLangSmithTurn = {
  agent: string | null;
  assistant: string[];
  duplicateRunIds: string[];
  endTime: string | null;
  error: string | null;
  model: string | null;
  projectId: string | null;
  projectName: string | null;
  runId: string;
  runName: string;
  runType: string;
  startTime: string;
  status: string | null;
  tokenUsage: {
    completion: number | null;
    prompt: number | null;
    total: number | null;
  };
  traceId: string;
  traceUrl: string | null;
  turnId: string | null;
  turnNumber: number | null;
  user: string[];
};

export type CompactLangSmithThread = {
  agent: string | null;
  cwd: string | null;
  threadId: string;
  turns: CompactLangSmithTurn[];
};

export type LangSmithPullResult = {
  runs: LangSmithRunRecord[];
  truncated: boolean;
};

export type LangSmithProjectSelector =
  | { projectId: string; projectName?: never }
  | { projectId?: never; projectName: string };
