export type ConnectorId =
  | "git-repo"
  | "google"
  | "hackernews"
  | "langsmith"
  | "notion"
  | "slack"
  | "web-search"
  | "x";

export type ConnectorBackend =
  "direct-api" | "local-git" | "mcp-http" | "mcp-stdio";

export type ConnectorDefinition = {
  backend: ConnectorBackend;
  description: string;
  displayName: string;
  id: ConnectorId;
  requiredEnv: string[];
  supportsAgenticDiscovery: boolean;
};

export type ConnectorIngestOptions = {
  connectorConfig?: Record<string, unknown>;
  instanceId?: string;
  limit?: number;
  streams?: string[];
  windowHours?: number;
};

export type ConnectorIngestResult = {
  checkpointToken?: string;
  connectorId: ConnectorId;
  message: string;
  queryWindow?: {
    since: string;
    until: string;
  };
  rawFiles: string[];
  replayed?: boolean;
  runId: string;
  statePath: string;
  status: "error" | "skipped" | "success";
  warnings: string[];
};

export type ConnectorRuntime = ConnectorDefinition & {
  acknowledge?: (result: ConnectorIngestResult) => Promise<void>;
  ingest: (options?: ConnectorIngestOptions) => Promise<ConnectorIngestResult>;
};

export type ConnectorState = {
  lastRunAt?: string;
  latestIds?: Record<string, string>;
  pendingIds?: Record<string, string[]>;
  runs?: ConnectorRunSummary[];
  version: 1;
};

export type ConnectorRunSummary = {
  at: string;
  rawFiles: string[];
  runId: string;
  status: ConnectorIngestResult["status"];
  warnings: string[];
};

export type ConnectorSourceUpdate = {
  connectorId: ConnectorId;
  rawFiles: string[];
};

export type ConnectorSourceUpdateReceipt = {
  connectorId: ConnectorId;
  outcome: "no_changes" | "updated";
  rawFilesRead: string[];
  summary: string;
};

export type McpConnectorConfig = {
  allowedTools?: string[];
  enabled?: boolean;
  mode?: "mcp-http" | "mcp-stdio";
  transport?: {
    args?: string[];
    command?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    type: "http" | "stdio";
    url?: string;
  };
  readOnlyOperations?: McpReadOnlyOperation[];
};

export type McpReadOnlyOperation = {
  args?: Record<string, unknown>;
  name: string;
  type: "resource" | "tool";
};
