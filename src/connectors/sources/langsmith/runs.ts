import { createHash } from "node:crypto";

import {
  isSecretLikeKey,
  sanitizeDiagnosticText,
} from "../../../diagnostics.js";
import type {
  CompactLangSmithThread,
  CompactLangSmithTurn,
  LangSmithRunRecord,
} from "./types.js";

type CompactRunsResult = {
  duplicateRuns: number;
  logicalTurns: number;
  threads: CompactLangSmithThread[];
};

const USER_ROLES = new Set(["human", "user"]);
const ASSISTANT_ROLES = new Set(["ai", "assistant"]);
const MIN_SECRET_VALUE_LENGTH = 8;
const THREAD_FILE_HASH_LENGTH = 24;

export function compactLangSmithRuns(
  runs: LangSmithRunRecord[],
  project: { id: string | null; name: string | null },
  apiUrl: string,
): CompactRunsResult {
  const logicalTurns = new Map<
    string,
    { aliases: LangSmithRunRecord[]; canonical: LangSmithRunRecord }
  >();

  for (const run of [...runs].sort(compareRuns)) {
    const metadata = getMetadata(run);
    const threadId = getThreadId(run, metadata);
    const logicalTurnId =
      getString(metadata, "turn_id") ?? run.trace_id ?? run.id;
    const logicalTurnKey = JSON.stringify([threadId, logicalTurnId]);
    const existing = logicalTurns.get(logicalTurnKey);

    if (existing) {
      existing.aliases.push(run);
      if (isPreferredCanonical(run, existing.canonical)) {
        existing.canonical = run;
      }
    } else {
      logicalTurns.set(logicalTurnKey, {
        aliases: [run],
        canonical: run,
      });
    }
  }

  const threads = new Map<string, CompactLangSmithThread>();
  for (const { aliases, canonical } of logicalTurns.values()) {
    const duplicateRunIds = aliases
      .filter((alias) => alias !== canonical)
      .map((alias) => alias.id)
      .sort();
    const metadata = getMetadata(canonical);
    const threadId = getThreadId(canonical, metadata);
    const agent =
      getString(metadata, "agent_name") ??
      getString(metadata, "ls_agent_runtime");
    const thread = threads.get(threadId) ?? {
      agent: sanitizeNullableTraceText(agent),
      cwd: sanitizeNullableTraceText(getString(metadata, "cwd")),
      threadId: sanitizeLangSmithText(threadId),
      turns: [],
    };

    thread.turns.push(
      compactTurn(
        canonical,
        aliases,
        duplicateRunIds,
        project,
        apiUrl,
        metadata,
      ),
    );
    threads.set(threadId, thread);
  }

  const compactThreads = [...threads.values()]
    .map((thread) => ({
      ...thread,
      turns: thread.turns.sort((left, right) =>
        left.startTime.localeCompare(right.startTime),
      ),
    }))
    .sort((left, right) => {
      const leftStart = left.turns[0]?.startTime ?? "";
      const rightStart = right.turns[0]?.startTime ?? "";
      return (
        leftStart.localeCompare(rightStart) ||
        left.threadId.localeCompare(right.threadId)
      );
    });

  return {
    duplicateRuns: runs.length - logicalTurns.size,
    logicalTurns: logicalTurns.size,
    threads: compactThreads,
  };
}

function getThreadId(
  run: LangSmithRunRecord,
  metadata: Record<string, unknown>,
): string {
  return (
    getString(metadata, "thread_id") ??
    getString(metadata, "conversation_id") ??
    getString(metadata, "session_id") ??
    run.trace_id ??
    run.id
  );
}

export function createThreadManifestEntry(
  thread: CompactLangSmithThread,
  file: string,
) {
  const firstUserText = thread.turns
    .flatMap((turn) => turn.user)
    .find((text) => text.trim().length > 0);

  return {
    agent: thread.agent,
    cwd: thread.cwd,
    endTime: thread.turns.at(-1)?.endTime ?? null,
    errorTurns: thread.turns.filter(
      (turn) => turn.status === "error" || turn.error,
    ).length,
    file,
    startTime: thread.turns[0]?.startTime ?? null,
    threadId: thread.threadId,
    title:
      firstUserText?.trim().split(/\r?\n/u, 1)[0]?.slice(0, 240) ??
      "(no user text)",
    tokens: thread.turns.reduce(
      (total, turn) => total + (turn.tokenUsage.total ?? 0),
      0,
    ),
    traceIds: thread.turns.map((turn) => turn.traceId),
    turns: thread.turns.length,
  };
}

export function createThreadFileIdentifier(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("hex");
  return `thread-${digest.slice(0, THREAD_FILE_HASH_LENGTH)}`;
}

export function sanitizePathSegment(value: string): string {
  return createThreadFileIdentifier(value);
}

function compactTurn(
  run: LangSmithRunRecord,
  aliases: LangSmithRunRecord[],
  duplicateRunIds: string[],
  project: { id: string | null; name: string | null },
  apiUrl: string,
  metadata: Record<string, unknown>,
): CompactLangSmithTurn {
  const startTime = toIso(run.start_time) ?? new Date(0).toISOString();

  return {
    agent: sanitizeNullableTraceText(
      getString(metadata, "agent_name") ??
        getString(metadata, "ls_agent_runtime"),
    ),
    assistant: mergeRoleText(aliases, ASSISTANT_ROLES),
    duplicateRunIds: duplicateRunIds.map(sanitizeLangSmithText),
    endTime: toIso(run.end_time) ?? null,
    error: run.error ? sanitizeLangSmithText(run.error) : null,
    model: sanitizeNullableTraceText(getString(metadata, "model")),
    projectId: sanitizeNullableTraceText(project.id),
    projectName: sanitizeNullableTraceText(project.name),
    runId: sanitizeLangSmithText(run.id),
    runName: sanitizeLangSmithText(run.name),
    runType: sanitizeLangSmithText(run.run_type),
    startTime,
    status: sanitizeNullableTraceText(run.status ?? null),
    tokenUsage: {
      completion: run.completion_tokens ?? null,
      prompt: run.prompt_tokens ?? null,
      total: run.total_tokens ?? null,
    },
    traceId: sanitizeLangSmithText(run.trace_id ?? run.id),
    traceUrl: createTraceUrl(apiUrl, run.app_path),
    turnId: sanitizeNullableTraceText(getString(metadata, "turn_id")),
    turnNumber: getNumber(metadata, "turn_number"),
    user: mergeRoleText(aliases, USER_ROLES),
  };
}

function mergeRoleText(
  runs: LangSmithRunRecord[],
  roles: Set<string>,
): string[] {
  return [
    ...new Set(
      runs.flatMap((run) => [
        ...extractRoleText(run.inputs, roles),
        ...extractRoleText(run.outputs, roles),
        ...(roles === ASSISTANT_ROLES
          ? extractOutputAgentMessageText(run.outputs)
          : []),
      ]),
    ),
  ];
}

function extractRoleText(value: unknown, roles: Set<string>): string[] {
  const texts: string[] = [];
  visitMessages(value, roles, texts);
  return [...new Set(texts.map(sanitizeLangSmithText))];
}

export function sanitizeLangSmithText(value: string): string {
  let sanitized = sanitizeDiagnosticText(value);

  const secretEnvironmentEntries = Object.entries(process.env)
    .filter((entry): entry is [string, string] => {
      const [key, secret] = entry;
      return (
        isSecretLikeKey(key) &&
        typeof secret === "string" &&
        secret.length >= MIN_SECRET_VALUE_LENGTH
      );
    })
    .sort((left, right) => right[1].length - left[1].length);

  for (const [key, secret] of secretEnvironmentEntries) {
    sanitized = sanitized.split(secret).join(`[REDACTED:${key}]`);
  }

  return sanitized
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu,
      "[REDACTED:PRIVATE_KEY]",
    )
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{20,}\b/giu, "[REDACTED:SLACK_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "[REDACTED:GOOGLE_API_KEY]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED:AWS_ACCESS_KEY_ID]")
    .replace(
      /(\b(?:aws[\s_-]*secret[\s_-]*access[\s_-]*key|secret[\s_-]*access[\s_-]*key)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/giu,
      "$1[REDACTED:AWS_SECRET_ACCESS_KEY]",
    )
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/giu, "[REDACTED:GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/giu, "[REDACTED:GITHUB_TOKEN]")
    .replace(
      /\bsecret_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/gu,
      "[REDACTED:NOTION_TOKEN]",
    )
    .replace(
      /\blin_api_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/gu,
      "[REDACTED:LINEAR_API_KEY]",
    )
    .replace(
      /\b((?:postgres(?:ql)?|mysql|redis|https?):\/\/[^/\s:@]+:)[^/@\s]+(@)/giu,
      "$1[REDACTED:URI_PASSWORD]$2",
    );
}

function sanitizeNullableTraceText(value: string | null): string | null {
  return value === null ? null : sanitizeLangSmithText(value);
}

function extractOutputAgentMessageText(value: unknown): string[] {
  const texts: string[] = [];
  visitOutputAgentMessages(value, texts);
  return [...new Set(texts.map(sanitizeLangSmithText))];
}

function visitOutputAgentMessages(value: unknown, texts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitOutputAgentMessages(item, texts);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const raw = isRecord(value._raw) ? value._raw : null;
  if (raw?.type === "agent_message") {
    texts.push(...extractContentText(raw.content));
  }

  for (const child of Object.values(value)) {
    visitOutputAgentMessages(child, texts);
  }
}

function visitMessages(
  value: unknown,
  roles: Set<string>,
  texts: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitMessages(item, roles, texts);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const role =
    typeof value.role === "string"
      ? value.role.toLowerCase()
      : typeof value.type === "string"
        ? value.type.toLowerCase()
        : null;
  if (role && roles.has(role)) {
    texts.push(...extractContentText(value.content));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "messages" || key === "message") {
      visitMessages(child, roles, texts);
    }
  }
}

function extractContentText(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string") {
      return item.trim().length > 0 ? [item] : [];
    }

    if (
      isRecord(item) &&
      (item.type === "text" ||
        item.type === "input_text" ||
        item.type === "output_text") &&
      typeof item.text === "string" &&
      item.text.trim().length > 0
    ) {
      return [item.text];
    }

    return [];
  });
}

function getMetadata(run: LangSmithRunRecord): Record<string, unknown> {
  const extra = run.extra ?? {};
  const metadata = isRecord(extra.metadata) ? extra.metadata : {};
  const customMetadata = isRecord(extra.custom_metadata)
    ? extra.custom_metadata
    : {};

  return { ...extra, ...metadata, ...customMetadata };
}

function createTraceUrl(
  apiUrl: string,
  appPath: string | undefined,
): string | null {
  if (!appPath) {
    return null;
  }

  const webOrigin = apiUrl.startsWith("https://eu.")
    ? "https://eu.smith.langchain.com"
    : "https://smith.langchain.com";
  try {
    const url = new URL(appPath, webOrigin);
    if (url.protocol !== "https:" || url.origin !== webOrigin) {
      return null;
    }

    url.hash = "";
    url.search = "";
    return sanitizeLangSmithText(url.toString());
  } catch {
    return null;
  }
}

function isPreferredCanonical(
  candidate: LangSmithRunRecord,
  current: LangSmithRunRecord,
): boolean {
  const candidateHasAssistant =
    mergeRoleText([candidate], ASSISTANT_ROLES).length > 0;
  const currentHasAssistant =
    mergeRoleText([current], ASSISTANT_ROLES).length > 0;
  if (candidateHasAssistant !== currentHasAssistant) {
    return candidateHasAssistant;
  }

  const endComparison = (toIso(candidate.end_time) ?? "").localeCompare(
    toIso(current.end_time) ?? "",
  );
  return endComparison !== 0
    ? endComparison > 0
    : candidate.id.localeCompare(current.id) < 0;
}

function compareRuns(
  left: LangSmithRunRecord,
  right: LangSmithRunRecord,
): number {
  const timeComparison = (toIso(left.start_time) ?? "").localeCompare(
    toIso(right.start_time) ?? "",
  );
  return timeComparison || left.id.localeCompare(right.id);
}

function toIso(value: number | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function getString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" && item.length > 0 ? item : null;
}

function getNumber(value: Record<string, unknown>, key: string): number | null {
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
