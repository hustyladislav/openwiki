import { Client } from "langsmith";
import type { Run } from "langsmith";
import type {
  LangSmithProjectSelector,
  LangSmithPullResult,
  LangSmithRunRecord,
} from "./types.js";

const RUN_SELECT_FIELDS = [
  "app_path",
  "completion_tokens",
  "end_time",
  "error",
  "extra",
  "id",
  "inputs",
  "name",
  "outputs",
  "prompt_tokens",
  "run_type",
  "start_time",
  "status",
  "tags",
  "total_tokens",
  "trace_id",
];

const ALLOWED_API_URLS = new Set([
  "https://api.smith.langchain.com",
  "https://eu.api.smith.langchain.com",
]);

export type LangSmithApi = {
  close(): void;
  readRuns(runIds: string[]): Promise<LangSmithRunRecord[]>;
  resolveProject(
    project: LangSmithProjectSelector,
  ): Promise<{ id: string; name: string }>;
  queryRootRuns(input: {
    limit?: number;
    project: LangSmithProjectSelector;
    since: string;
    until: string;
  }): Promise<LangSmithPullResult>;
};

export function createLangSmithApi(
  apiUrl: string,
  apiKey: string,
): LangSmithApi {
  const normalizedApiUrl = normalizeLangSmithApiUrl(apiUrl);
  const client = new Client({ apiKey, apiUrl: normalizedApiUrl });

  return {
    close() {
      client.cleanup();
    },
    async queryRootRuns({ limit, project, since, until }) {
      const runs: LangSmithRunRecord[] = [];

      for await (const run of client.listRuns({
        ...project,
        filter: `lt(start_time, "${until}")`,
        isRoot: true,
        ...(limit === undefined ? {} : { limit: limit + 1 }),
        order: "asc",
        select: RUN_SELECT_FIELDS,
        startTime: new Date(since),
      })) {
        runs.push(toRunRecord(run));
        if (limit !== undefined && runs.length > limit) {
          break;
        }
      }

      const truncated = limit !== undefined && runs.length > limit;
      return {
        runs: limit === undefined ? runs : runs.slice(0, limit),
        truncated,
      };
    },
    async readRuns(runIds) {
      const runs: LangSmithRunRecord[] = [];
      if (runIds.length === 0) {
        return runs;
      }

      for await (const run of client.listRuns({
        id: runIds,
        select: RUN_SELECT_FIELDS,
      })) {
        runs.push(toRunRecord(run));
      }

      return runs;
    },
    async resolveProject(project) {
      const resolved = await client.readProject(project);
      const name = resolved.name?.trim();
      if (!name) {
        throw new Error(
          `LangSmith project ${resolved.id} did not include a project name.`,
        );
      }

      return { id: resolved.id, name };
    },
  };
}

export function normalizeLangSmithApiUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("LangSmith apiUrl must be a valid URL.");
  }

  const normalized = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}`;
  if (!ALLOWED_API_URLS.has(normalized)) {
    throw new Error(
      "LangSmith apiUrl must be https://api.smith.langchain.com or https://eu.api.smith.langchain.com.",
    );
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "LangSmith apiUrl must not contain credentials or URL parameters.",
    );
  }

  return normalized;
}

function toRunRecord(run: Run): LangSmithRunRecord {
  return {
    app_path: run.app_path,
    completion_tokens: run.completion_tokens,
    end_time: run.end_time,
    error: run.error,
    extra: asRecord(run.extra),
    id: run.id,
    inputs: asRecord(run.inputs) ?? {},
    name: run.name,
    outputs: asRecord(run.outputs),
    prompt_tokens: run.prompt_tokens,
    run_type: run.run_type,
    start_time: run.start_time,
    status: run.status,
    tags: run.tags,
    total_tokens: run.total_tokens,
    trace_id: run.trace_id,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
