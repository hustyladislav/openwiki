import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  LANGSMITH_API_KEY_ENV_KEY,
  resolveOpenWikiLangSmithEndpoint,
} from "../../../constants.js";
import { sanitizeDiagnosticText } from "../../../diagnostics.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  withConnectorLock,
  writeConnectorState,
  writeRawJson,
} from "../../io.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
  ConnectorState,
} from "../../types.js";
import {
  createLangSmithApi,
  normalizeLangSmithApiUrl,
  type LangSmithApi,
} from "./api.js";
import {
  compactLangSmithRuns,
  createThreadManifestEntry,
  sanitizeLangSmithText,
} from "./runs.js";
import type {
  LangSmithConfig,
  LangSmithProjectIdentity,
  LangSmithProjectSelector,
  LangSmithRunRecord,
} from "./types.js";

const DEFAULT_OVERLAP_HOURS = 24;
const DEFAULT_WINDOW_HOURS = 24;
const LANGSMITH_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const STATE_PATH = "~/.openwiki/connectors/langsmith/state.json";

type LangSmithConnectorDependencies = {
  createApi?: (apiUrl: string, apiKey: string) => LangSmithApi;
  now?: () => Date;
};

type LangSmithStagedBatch = {
  checkpointToken: string;
  message: string;
  nextCursor?: string;
  nextPendingIds: string[];
  nextSeenHashes: Record<string, string>;
  queryWindow: { since: string; until: string };
  rawFiles: string[];
  runId: string;
  selectionKey?: string;
  status: ConnectorIngestResult["status"];
  warnings: string[];
};

type LangSmithConnectorState = ConnectorState & {
  langsmith?: {
    pendingBatches?: Record<string, LangSmithStagedBatch>;
    seenHashes?: Record<string, Record<string, string>>;
  };
};

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches complete LangSmith root-run windows and writes compact user/assistant conversation evidence grouped by thread.",
  displayName: "LangSmith",
  id: "langsmith",
  requiredEnv: [LANGSMITH_API_KEY_ENV_KEY],
  supportsAgenticDiscovery: false,
};

export function createLangSmithConnector(
  dependencies: LangSmithConnectorDependencies = {},
): ConnectorRuntime {
  return {
    ...definition,
    acknowledge: (result) =>
      withConnectorLock("langsmith", () => acknowledge(result), {
        timeoutMs: LANGSMITH_LOCK_TIMEOUT_MS,
      }),
    ingest: (options) =>
      withConnectorLock("langsmith", () => ingest(options, dependencies), {
        timeoutMs: LANGSMITH_LOCK_TIMEOUT_MS,
      }),
  };
}

async function acknowledge(result: ConnectorIngestResult): Promise<void> {
  if (result.connectorId !== "langsmith" || !result.checkpointToken) {
    return;
  }

  const state = (await readConnectorState(
    "langsmith",
  )) as LangSmithConnectorState;
  const pendingEntries = Object.entries(state.langsmith?.pendingBatches ?? {});
  const pendingEntry = pendingEntries.find(
    ([, batch]) => batch.checkpointToken === result.checkpointToken,
  );
  if (!pendingEntry) {
    throw new Error(
      "LangSmith checkpoint acknowledgement was not found in pending state.",
    );
  }

  const [checkpointKey, batch] = pendingEntry;
  const pendingBatches = {
    ...(state.langsmith?.pendingBatches ?? {}),
  };
  delete pendingBatches[checkpointKey];
  const nextState: LangSmithConnectorState = {
    ...state,
    latestIds: batch.nextCursor
      ? {
          ...(state.latestIds ?? {}),
          [checkpointKey]: batch.nextCursor,
        }
      : state.latestIds,
    pendingIds: {
      ...(state.pendingIds ?? {}),
      [checkpointKey]: batch.nextPendingIds,
    },
    langsmith: {
      ...state.langsmith,
      pendingBatches,
      seenHashes: {
        ...(state.langsmith?.seenHashes ?? {}),
        [checkpointKey]: batch.nextSeenHashes,
      },
    },
  };

  await writeConnectorState("langsmith", nextState);
}

async function ingest(
  options: ConnectorIngestOptions = {},
  dependencies: LangSmithConnectorDependencies,
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = mergeLangSmithConfig(
    await readConnectorConfig<LangSmithConfig>("langsmith", {
      enabled: false,
      excludeTags: ["openwiki"],
      overlapHours: DEFAULT_OVERLAP_HOURS,
    }),
    options.connectorConfig ?? {},
  );
  const state = (await readConnectorState(
    "langsmith",
  )) as LangSmithConnectorState;
  const warnings: string[] = [];

  if (!config.enabled) {
    return createResult({
      message:
        "LangSmith connector is not enabled. Set enabled=true in ~/.openwiki/connectors/langsmith/config.json.",
      rawFiles: [],
      runId,
      status: "skipped",
      warnings,
    });
  }

  let project: LangSmithProjectSelector;
  try {
    project = resolveProject(config);
  } catch (error) {
    return createResult({
      message: sanitizeDiagnosticText(getErrorMessage(error)),
      rawFiles: [],
      runId,
      status: "error",
      warnings,
    });
  }

  let apiUrl: string;
  try {
    apiUrl = normalizeLangSmithApiUrl(
      config.apiUrl ?? resolveOpenWikiLangSmithEndpoint(),
    );
  } catch (error) {
    return createResult({
      message: sanitizeDiagnosticText(getErrorMessage(error)),
      rawFiles: [],
      runId,
      status: "error",
      warnings,
    });
  }

  const selectionKey = createStagedBatchSelectionKey({
    apiUrl,
    instanceId: options.instanceId,
    project,
  });
  const localStagedBatch = findLocalStagedBatch({
    legacyCheckpointKey: project.projectId
      ? cursorKey(options.instanceId, apiUrl, project.projectId)
      : undefined,
    selectionKey,
    state,
  });
  if (localStagedBatch) {
    return createReplayResult(localStagedBatch);
  }

  const apiKey = process.env[LANGSMITH_API_KEY_ENV_KEY];
  if (!apiKey) {
    return createResult({
      message: `Missing ${LANGSMITH_API_KEY_ENV_KEY}. Add it to ~/.openwiki/.env.`,
      rawFiles: [],
      runId,
      status: "error",
      warnings,
    });
  }

  const apiFactory = dependencies.createApi ?? createLangSmithApi;
  const api = apiFactory(apiUrl, apiKey);
  const now = dependencies.now?.() ?? new Date();

  try {
    const projectIdentity = await api.resolveProject(project);
    rejectOpenWikiTraceProject(config, projectIdentity);
    const checkpointKey = cursorKey(
      options.instanceId,
      apiUrl,
      projectIdentity.id,
    );
    const manifestProjectIdentity: LangSmithProjectIdentity = {
      id: sanitizeLangSmithText(projectIdentity.id),
      name: sanitizeLangSmithText(projectIdentity.name),
    };
    const existingStagedBatch =
      state.langsmith?.pendingBatches?.[checkpointKey];
    if (existingStagedBatch) {
      return createReplayResult(existingStagedBatch);
    }

    const window = resolveWindow({
      config,
      cursor: state.latestIds?.[checkpointKey],
      now,
      windowHours: options.windowHours,
    });
    const limit = normalizeExplicitLimit(options.limit);
    const pull = await api.queryRootRuns({ limit, project, ...window });
    const previousPendingIds = state.pendingIds?.[checkpointKey] ?? [];
    const pendingRefresh = await api.readRuns(previousPendingIds);
    const mergedRuns = mergeRunsById(pull.runs, pendingRefresh);
    const excludedByTag = excludeRuns(
      mergedRuns,
      config.excludeTags ?? ["openwiki"],
    );
    const scoped = includeRunsInScope(
      excludedByTag.included,
      config.includeCwdPrefixes,
    );
    const eligibleRuns = scoped.included.filter(
      (run) => run.status !== "pending",
    );
    const nextPendingIds = resolvePendingIds({
      includedRuns: scoped.included,
      mergedRuns,
      previousPendingIds,
    });
    const currentHashes = Object.fromEntries(
      eligibleRuns.map((run) => [run.id, hashRun(run)]),
    );
    const previousHashes = state.langsmith?.seenHashes?.[checkpointKey] ?? {};
    const changedRunIds = new Set(
      eligibleRuns
        .filter((run) => previousHashes[run.id] !== currentHashes[run.id])
        .map((run) => run.id),
    );
    const compactAll = compactLangSmithRuns(
      eligibleRuns,
      projectIdentity,
      apiUrl,
    );
    const compact = selectChangedTurns(compactAll, changedRunIds);
    const threadManifest = [];
    const threadRawFiles: string[] = [];

    for (const [index, thread] of compact.threads.entries()) {
      const fileName = `threads/${String(index + 1).padStart(5, "0")}-${hashIdentifier(thread.threadId)}.json`;
      threadRawFiles.push(
        await writeRawJson("langsmith", runId, fileName, thread),
      );
      threadManifest.push(createThreadManifestEntry(thread, fileName));
    }

    const rawFiles: string[] = [];
    if (compact.logicalTurns > 0) {
      const manifestPath = await writeRawJson(
        "langsmith",
        runId,
        "manifest.json",
        {
          connectorId: "langsmith",
          coverage: {
            completeWindow: !pull.truncated,
            duplicateRoots: compactAll.duplicateRuns,
            excludedByScope: scoped.excluded,
            excludedByTag: excludedByTag.excluded,
            logicalTurns: compact.logicalTurns,
            logicalTurnsInWindow: compactAll.logicalTurns,
            pendingRoots: nextPendingIds.length,
            rootRunsChanged: changedRunIds.size,
            rootRunsFetched: mergedRuns.length,
            rootRunsIncluded: eligibleRuns.length,
            scope: "root-runs",
            threads: compact.threads.length,
          },
          fetchedAt: now.toISOString(),
          instanceId: options.instanceId ?? null,
          project: manifestProjectIdentity,
          query: window,
          threads: threadManifest,
        },
      );
      rawFiles.push(manifestPath, ...threadRawFiles);
    }

    if (scoped.excluded > 0) {
      warnings.push(
        `${scoped.excluded} root run(s) were outside the configured cwd scope and were not persisted.`,
      );
    }
    if (pull.truncated) {
      warnings.push(
        "The explicit ingestion limit was reached. The cursor was not advanced, so a later uncapped run can ingest the complete window.",
      );
    }

    const status = rawFiles.length > 0 ? "success" : "skipped";
    const message =
      rawFiles.length > 0
        ? `Pulled ${pull.runs.length} LangSmith root run(s); ${compact.logicalTurns} new or changed logical turn(s) across ${compact.threads.length} thread(s) are ready for synthesis.`
        : `Pulled ${pull.runs.length} LangSmith root run(s); no new or changed terminal turns require synthesis.`;
    const checkpointToken = randomUUID();
    const stagedBatch: LangSmithStagedBatch = {
      checkpointToken,
      message,
      nextCursor: pull.truncated ? undefined : window.until,
      nextPendingIds,
      nextSeenHashes: pull.truncated
        ? { ...previousHashes, ...currentHashes }
        : currentHashes,
      queryWindow: window,
      rawFiles,
      runId,
      selectionKey,
      status,
      warnings,
    };
    const nextState = updateStateWithRun(state, {
      at: now.toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }) as LangSmithConnectorState;
    nextState.langsmith = {
      ...nextState.langsmith,
      pendingBatches: {
        ...(nextState.langsmith?.pendingBatches ?? {}),
        [checkpointKey]: stagedBatch,
      },
    };
    await writeConnectorState("langsmith", nextState);

    return createResult({
      checkpointToken,
      message,
      queryWindow: window,
      rawFiles,
      runId,
      status,
      warnings,
    });
  } catch (error) {
    const message = sanitizeDiagnosticText(getErrorMessage(error));
    warnings.push(message);
    await writeConnectorState(
      "langsmith",
      updateStateWithRun(state, {
        at: now.toISOString(),
        rawFiles: [],
        runId,
        status: "error",
        warnings,
      }),
    );

    return createResult({
      message: `LangSmith ingestion failed: ${message}`,
      rawFiles: [],
      runId,
      status: "error",
      warnings,
    });
  } finally {
    api.close();
  }
}

function resolveProject(config: LangSmithConfig): LangSmithProjectSelector {
  const projectId = config.projectId?.trim();
  const projectName = config.projectName?.trim();

  if (projectId && projectName) {
    throw new Error(
      "LangSmith config must set projectId or projectName, not both.",
    );
  }

  if (projectId) {
    return { projectId };
  }

  if (projectName) {
    return { projectName };
  }

  throw new Error(
    "LangSmith config requires projectName or projectId in ~/.openwiki/connectors/langsmith/config.json.",
  );
}

function resolveWindow({
  config,
  cursor,
  now,
  windowHours,
}: {
  config: LangSmithConfig;
  cursor: string | undefined;
  now: Date;
  windowHours: number | undefined;
}): { since: string; until: string } {
  const requestedUntil =
    parseTimestamp(
      process.env.OPENWIKI_INGESTION_UNTIL,
      "OPENWIKI_INGESTION_UNTIL",
    ) ?? now;
  const configuredStart = parseTimestamp(config.startTime, "startTime");
  const environmentStart = parseTimestamp(
    process.env.OPENWIKI_INGESTION_SINCE,
    "OPENWIKI_INGESTION_SINCE",
  );
  const cursorDate = parseTimestamp(cursor, "LangSmith cursor");
  const overlapHours = normalizeOverlapHours(config.overlapHours);
  const batchHours = normalizeWindowHours(config.batchHours ?? windowHours);
  const progressStart =
    cursorDate ??
    configuredStart ??
    environmentStart ??
    new Date(requestedUntil.getTime() - batchHours * 60 * 60 * 1000);
  const start = cursorDate
    ? new Date(cursorDate.getTime() - overlapHours * 60 * 60 * 1000)
    : progressStart;
  const batchUntil = new Date(
    progressStart.getTime() + batchHours * 60 * 60 * 1000,
  );
  const until =
    batchUntil.getTime() < requestedUntil.getTime()
      ? batchUntil
      : requestedUntil;

  if (start.getTime() >= until.getTime()) {
    throw new Error(
      "LangSmith ingestion start time must be before its end time.",
    );
  }

  return { since: start.toISOString(), until: until.toISOString() };
}

function parseTimestamp(
  value: string | undefined,
  label: string,
): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }

  return date;
}

function normalizeOverlapHours(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_OVERLAP_HOURS;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error("LangSmith overlapHours must be a non-negative number.");
  }

  return value;
}

function normalizeWindowHours(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_WINDOW_HOURS;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("LangSmith windowHours must be a positive number.");
  }

  return value;
}

function normalizeExplicitLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("LangSmith ingestion limit must be a positive number.");
  }

  return value;
}

function cursorKey(
  instanceId: string | undefined,
  apiUrl: string,
  projectId: string,
): string {
  return `instance:${instanceId ?? "default"}:endpoint:${apiUrl}:project:${projectId}:successfulThrough`;
}

function createStagedBatchSelectionKey({
  apiUrl,
  instanceId,
  project,
}: {
  apiUrl: string;
  instanceId: string | undefined;
  project: LangSmithProjectSelector;
}): string {
  const configuredProject = project.projectId
    ? { type: "id", value: project.projectId }
    : { type: "name", value: project.projectName };
  const identity = JSON.stringify({
    apiUrl,
    instanceId: instanceId ?? null,
    project: configuredProject,
    version: 1,
  });

  return `v1:${createHash("sha256").update(identity).digest("hex")}`;
}

function findLocalStagedBatch({
  legacyCheckpointKey,
  selectionKey,
  state,
}: {
  legacyCheckpointKey: string | undefined;
  selectionKey: string;
  state: LangSmithConnectorState;
}): LangSmithStagedBatch | undefined {
  const pendingBatches = state.langsmith?.pendingBatches ?? {};
  const selected = Object.values(pendingBatches).find(
    (batch) => batch.selectionKey === selectionKey,
  );
  if (selected) {
    return selected;
  }

  if (!legacyCheckpointKey) {
    return undefined;
  }

  const legacy = pendingBatches[legacyCheckpointKey];
  return legacy?.selectionKey === undefined ? legacy : undefined;
}

function mergeLangSmithConfig(
  diskConfig: LangSmithConfig,
  instanceConfig: LangSmithConfig,
): LangSmithConfig {
  const merged = { ...diskConfig, ...instanceConfig };

  if (instanceConfig.projectId !== undefined) {
    delete merged.projectName;
  } else if (instanceConfig.projectName !== undefined) {
    delete merged.projectId;
  }

  return merged;
}

function rejectOpenWikiTraceProject(
  config: LangSmithConfig,
  project: LangSmithProjectIdentity,
): void {
  const tracingProject = process.env.LANGCHAIN_PROJECT ?? "openwiki";
  if (project.name === tracingProject && !config.allowOpenWikiProject) {
    throw new Error(
      `LangSmith source project ${project.name} is also OpenWiki's tracing project. Set allowOpenWikiProject=true only if self-ingestion is intentional.`,
    );
  }
}

function includeRunsInScope(
  runs: LangSmithRunRecord[],
  cwdPrefixes: string[] | undefined,
): { excluded: number; included: LangSmithRunRecord[] } {
  const prefixes = (cwdPrefixes ?? [])
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .map((prefix) => path.resolve(prefix));
  if (prefixes.length === 0) {
    return { excluded: 0, included: runs };
  }

  const included = runs.filter((run) => {
    const cwd = getRunMetadataString(run, "cwd");
    if (cwd === null) {
      return false;
    }

    const resolvedCwd = path.resolve(cwd);
    return prefixes.some((prefix) => isPathWithin(resolvedCwd, prefix));
  });
  return { excluded: runs.length - included.length, included };
}

function isPathWithin(candidatePath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function resolvePendingIds({
  includedRuns,
  mergedRuns,
  previousPendingIds,
}: {
  includedRuns: LangSmithRunRecord[];
  mergedRuns: LangSmithRunRecord[];
  previousPendingIds: string[];
}): string[] {
  const mergedById = new Map(mergedRuns.map((run) => [run.id, run]));
  const includedIds = new Set(includedRuns.map((run) => run.id));
  const pendingIds = new Set(
    previousPendingIds.filter((id) => {
      const run = mergedById.get(id);
      return (
        run === undefined || (includedIds.has(id) && run.status === "pending")
      );
    }),
  );

  for (const run of includedRuns) {
    if (run.status === "pending") {
      pendingIds.add(run.id);
    }
  }

  return [...pendingIds].sort();
}

function selectChangedTurns(
  compact: ReturnType<typeof compactLangSmithRuns>,
  changedRunIds: Set<string>,
): ReturnType<typeof compactLangSmithRuns> {
  const threads = compact.threads
    .map((thread) => ({
      ...thread,
      turns: thread.turns.filter((turn) =>
        [turn.runId, ...turn.duplicateRunIds].some((id) =>
          changedRunIds.has(id),
        ),
      ),
    }))
    .filter((thread) => thread.turns.length > 0);

  return {
    duplicateRuns: threads.reduce(
      (total, thread) =>
        total +
        thread.turns.reduce(
          (turnTotal, turn) => turnTotal + turn.duplicateRunIds.length,
          0,
        ),
      0,
    ),
    logicalTurns: threads.reduce(
      (total, thread) => total + thread.turns.length,
      0,
    ),
    threads,
  };
}

function hashRun(run: LangSmithRunRecord): string {
  return createHash("sha256").update(stableStringify(run)).digest("hex");
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function getRunMetadataString(
  run: LangSmithRunRecord,
  key: string,
): string | null {
  const metadata = isRecord(run.extra?.metadata) ? run.extra.metadata : {};
  const customMetadata = isRecord(run.extra?.custom_metadata)
    ? run.extra.custom_metadata
    : {};
  const value = customMetadata[key] ?? metadata[key] ?? run.extra?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function excludeRuns(
  runs: LangSmithRunRecord[],
  excludedTags: string[],
): { excluded: number; included: LangSmithRunRecord[] } {
  const normalizedTags = new Set(
    excludedTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  );
  const included = runs.filter(
    (run) =>
      !run.tags?.some((tag) => normalizedTags.has(tag.toLowerCase())) &&
      getOpenWikiMetadataFlag(run) !== true,
  );

  return { excluded: runs.length - included.length, included };
}

function mergeRunsById(
  windowRuns: LangSmithRunRecord[],
  refreshedRuns: LangSmithRunRecord[],
): LangSmithRunRecord[] {
  const runsById = new Map(windowRuns.map((run) => [run.id, run]));
  for (const run of refreshedRuns) {
    runsById.set(run.id, run);
  }

  return [...runsById.values()];
}

function getOpenWikiMetadataFlag(run: LangSmithRunRecord): boolean | undefined {
  const metadata = isRecord(run.extra?.metadata) ? run.extra.metadata : {};
  const customMetadata = isRecord(run.extra?.custom_metadata)
    ? run.extra.custom_metadata
    : {};
  const value = customMetadata.openwiki ?? metadata.openwiki;
  return typeof value === "boolean" ? value : undefined;
}

function createResult({
  checkpointToken,
  message,
  queryWindow,
  rawFiles,
  replayed,
  runId,
  status,
  warnings,
}: {
  checkpointToken?: string;
  message: string;
  queryWindow?: ConnectorIngestResult["queryWindow"];
  rawFiles: string[];
  replayed?: boolean;
  runId: string;
  status: ConnectorIngestResult["status"];
  warnings: string[];
}): ConnectorIngestResult {
  return {
    checkpointToken,
    connectorId: "langsmith",
    message,
    queryWindow,
    rawFiles,
    replayed,
    runId,
    statePath: STATE_PATH,
    status,
    warnings,
  };
}

function createReplayResult(
  stagedBatch: LangSmithStagedBatch,
): ConnectorIngestResult {
  return createResult({
    checkpointToken: stagedBatch.checkpointToken,
    message: `${stagedBatch.message} Replaying this batch because wiki synthesis has not been acknowledged yet.`,
    queryWindow: stagedBatch.queryWindow,
    rawFiles: stagedBatch.rawFiles,
    replayed: true,
    runId: stagedBatch.runId,
    status: stagedBatch.status,
    warnings: stagedBatch.warnings,
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
