import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectorAcknowledgeResult,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../src/connectors/types.ts";
import type { LangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import type {
  LangSmithProjectSelector,
  LangSmithRunRecord,
} from "../src/connectors/sources/langsmith/types.ts";

const API_KEY_ENV = "OPENWIKI_LANGSMITH_API_KEY";
const originalHome = process.env.HOME;
const originalApiKey = process.env[API_KEY_ENV];
const originalEndpoint = process.env.OPENWIKI_LANGSMITH_ENDPOINT;
const originalSince = process.env.OPENWIKI_INGESTION_SINCE;
const originalUntil = process.env.OPENWIKI_INGESTION_UNTIL;
const originalTracingProject = process.env.LANGCHAIN_PROJECT;
const tempHomes: string[] = [];

afterEach(async () => {
  vi.resetModules();
  restoreEnv("HOME", originalHome);
  restoreEnv(API_KEY_ENV, originalApiKey);
  restoreEnv("OPENWIKI_LANGSMITH_ENDPOINT", originalEndpoint);
  restoreEnv("OPENWIKI_INGESTION_SINCE", originalSince);
  restoreEnv("OPENWIKI_INGESTION_UNTIL", originalUntil);
  restoreEnv("LANGCHAIN_PROJECT", originalTracingProject);
  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("LangSmith connector", () => {
  test("skips when disabled and errors without the connector key", async () => {
    const home = await createTempHome();
    const { createLangSmithConnector } = await loadConnector(home);
    const disabled = await createLangSmithConnector().ingest({
      connectorConfig: { enabled: false },
    });
    expect(disabled.status).toBe("skipped");

    delete process.env[API_KEY_ENV];
    const missingKey = await createLangSmithConnector().ingest({
      connectorConfig: { enabled: true, projectName: "agent-project" },
    });
    expect(missingKey.status).toBe("error");
    expect(missingKey.message).toContain(API_KEY_ENV);
  });

  test("stages every root without a default cap and checkpoints only after acknowledgement", async () => {
    const home = await createTempHome();
    const fixedNow = new Date("2026-07-16T12:00:00.000Z");
    const runs = Array.from({ length: 251 }, (_, index) =>
      createRun(index, {
        startTime: new Date(
          Date.parse("2026-07-15T12:00:00.000Z") + index * 1000,
        ).toISOString(),
      }),
    );
    let receivedLimit: number | undefined;
    const api = createFakeApi({
      queryRootRuns: (input) => {
        receivedLimit = input.limit;
        return Promise.resolve({ runs, truncated: false });
      },
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({
      createApi: () => api,
      now: () => fixedNow,
    });
    const result = await connector.ingest({
      connectorConfig: {
        apiUrl: "https://eu.api.smith.langchain.com",
        enabled: true,
        projectName: "agent-project",
        startTime: "2026-07-15T12:00:00.000Z",
      },
      instanceId: "langsmith-1",
    });

    expect(receivedLimit).toBeUndefined();
    expect(result.status).toBe("success");
    expect(result.checkpointToken).toBeTypeOf("string");
    expect(result.rawFiles).toHaveLength(2);
    expect(path.basename(result.rawFiles[0])).toBe("manifest.json");
    expect(result.rawFiles[1]).toContain(`${path.sep}threads${path.sep}`);
    const manifest = await readJson<LangSmithManifest>(result.rawFiles[0]);
    expect(manifest.coverage).toMatchObject({
      completeWindow: true,
      logicalTurns: 251,
      rootRunsFetched: 251,
      rootRunsIncluded: 251,
      scope: "root-runs",
    });
    expect(manifest.threads).toHaveLength(1);

    const statePath = getStatePath(home);
    const stagedState = await readJson<ConnectorStateFile>(statePath);
    expect(stagedState.latestIds).toBeUndefined();
    expect(stagedState.langsmith?.lastAcknowledgedTransactions).toBeUndefined();
    expect(
      Object.values(stagedState.langsmith?.pendingBatches ?? {}),
    ).toHaveLength(1);

    await acknowledgeConnector(connector, result);
    const committedState = await readJson<ConnectorStateFile>(statePath);
    expect(Object.values(committedState.latestIds ?? {})).toContain(
      fixedNow.toISOString(),
    );
    expect(
      Object.values(committedState.langsmith?.pendingBatches ?? {}),
    ).toHaveLength(0);
    const [acknowledgedTransaction] = Object.values(
      committedState.langsmith?.lastAcknowledgedTransactions ?? {},
    );
    expect(acknowledgedTransaction).toMatchObject({
      acquisition: {
        pendingRootIdsCarriedMissing: 0,
        pendingRootIdsRequested: 0,
        pendingRootRunsRefreshed: 0,
        uniqueRootRunsEvaluated: 251,
        windowRootRunsFetched: 251,
      },
      checkpoint: {
        advanced: true,
        successfulThroughAfter: fixedNow.toISOString(),
        successfulThroughBefore: null,
      },
      connectorId: "langsmith",
      connectorStatus: "success",
      coverage: {
        completeWindow: true,
        changedLogicalTurns: 251,
        changedTerminalRootRuns: 251,
        changedThreads: 1,
        logicalTurnsEvaluated: 251,
        terminalRootRunsEligible: 251,
        threadsEvaluated: 1,
      },
      endpoint: "https://eu.api.smith.langchain.com",
      fetchedAt: fixedNow.toISOString(),
      instanceId: "langsmith-1",
      project: { id: "project-id", name: "agent-project" },
      query: {
        since: "2026-07-15T12:00:00.000Z",
        until: fixedNow.toISOString(),
      },
      rawEvidenceFileCount: 2,
      replayed: false,
      runId: result.runId,
      schemaVersion: 1,
      scope: {
        excludeTags: ["openwiki"],
        includeCwdPrefixes: [],
        kind: "root-runs",
      },
      synthesisOutcome: "updated",
      warnings: [],
    });
    expect(JSON.stringify(acknowledgedTransaction)).not.toContain(home);
    expect((await stat(result.rawFiles[0])).mode & 0o777).toBe(0o600);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  test("returns the manifest first followed by every written thread file", async () => {
    const home = await createTempHome();
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({
          runs: [
            createRun(1, { threadId: "thread-1" }),
            createRun(2, { threadId: "thread-2" }),
          ],
          truncated: false,
        }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const result = await createLangSmithConnector({
      createApi: () => api,
    }).ingest(createOptions());
    const manifest = await readJson<LangSmithManifest>(result.rawFiles[0]);
    const returnedThreadFiles = result.rawFiles
      .slice(1)
      .map((filePath) =>
        path.relative(path.dirname(result.rawFiles[0]), filePath),
      );

    expect(result.rawFiles).toHaveLength(3);
    expect(returnedThreadFiles).toEqual(
      manifest.threads.map((thread) => thread.file),
    );
  });

  test("does not acknowledge source evidence without a synthesis outcome", async () => {
    const home = await createTempHome();
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({ runs: [createRun(1)], truncated: false }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const result = await connector.ingest(createOptions());

    await expect(connector.acknowledge?.(result)).rejects.toThrow(
      "require a valid synthesis outcome",
    );
    const state = await readJson<ConnectorStateFile>(getStatePath(home));
    expect(state.latestIds).toBeUndefined();
    expect(Object.values(state.langsmith?.pendingBatches ?? {})).toHaveLength(
      1,
    );
  });

  test("replays an unacknowledged batch without refetching", async () => {
    const home = await createTempHome();
    let queryCount = 0;
    const api = createFakeApi({
      queryRootRuns: () => {
        queryCount += 1;
        return Promise.resolve({ runs: [createRun(1)], truncated: false });
      },
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const options = createOptions();

    const first = await connector.ingest(options);
    const replay = await connector.ingest(options);

    expect(queryCount).toBe(1);
    expect(replay).toMatchObject({
      checkpointToken: first.checkpointToken,
      rawFiles: first.rawFiles,
      replayed: true,
      runId: first.runId,
    });
    await acknowledgeConnector(connector, replay);
    const state = await readJson<ConnectorStateFile>(getStatePath(home));
    const [acknowledgedTransaction] = Object.values(
      state.langsmith?.lastAcknowledgedTransactions ?? {},
    );
    expect(typeof acknowledgedTransaction?.fetchedAt).toBe("string");
    expect(acknowledgedTransaction).toMatchObject({
      replayed: true,
      runId: first.runId,
    });
  });

  test("replays a staged batch without an API key or client construction", async () => {
    const home = await createTempHome();
    let clientCreations = 0;
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({ runs: [createRun(1)], truncated: false }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({
      createApi: () => {
        clientCreations += 1;
        return api;
      },
    });
    const options = createOptions();
    const first = await connector.ingest(options);
    delete process.env[API_KEY_ENV];

    const replay = await connector.ingest(options);

    expect(clientCreations).toBe(1);
    expect(replay).toMatchObject({
      checkpointToken: first.checkpointToken,
      rawFiles: first.rawFiles,
      replayed: true,
      runId: first.runId,
    });
  });

  test("replays a staged batch without resolving the project again", async () => {
    const home = await createTempHome();
    let projectResolutions = 0;
    let serviceUnavailable = false;
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({ runs: [createRun(1)], truncated: false }),
      resolveProject: () => {
        projectResolutions += 1;
        if (serviceUnavailable) {
          return Promise.reject(new Error("LangSmith unavailable"));
        }
        return Promise.resolve({ id: "project-id", name: "agent-project" });
      },
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const options = createOptions();
    const first = await connector.ingest(options);
    serviceUnavailable = true;

    const replay = await connector.ingest(options);

    expect(projectResolutions).toBe(1);
    expect(replay).toMatchObject({
      checkpointToken: first.checkpointToken,
      rawFiles: first.rawFiles,
      replayed: true,
      runId: first.runId,
    });
  });

  test("replays a legacy staged batch by exact configured project ID", async () => {
    const home = await createTempHome();
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({ runs: [createRun(1)], truncated: false }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const options = createOptions({ projectId: "project-id" });
    const first = await connector.ingest(options);
    const statePath = getStatePath(home);
    const state = await readJson<LegacyConnectorStateFile>(statePath);
    const [stagedBatch] = Object.values(state.langsmith?.pendingBatches ?? {});
    if (!stagedBatch) {
      throw new Error("Expected a staged LangSmith batch.");
    }
    delete stagedBatch.selectionKey;
    delete stagedBatch.transaction;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    delete process.env[API_KEY_ENV];

    const replay = await connector.ingest(options);

    expect(replay).toMatchObject({
      checkpointToken: first.checkpointToken,
      rawFiles: first.rawFiles,
      replayed: true,
      runId: first.runId,
    });
    await acknowledgeConnector(connector, replay);
    const acknowledgedState = await readJson<ConnectorStateFile>(statePath);
    expect(
      Object.values(acknowledgedState.langsmith?.pendingBatches ?? {}),
    ).toHaveLength(0);
    const [acknowledgedTransaction] = Object.values(
      acknowledgedState.langsmith?.lastAcknowledgedTransactions ?? {},
    );
    if (!acknowledgedTransaction) {
      throw new Error("Expected an acknowledged LangSmith transaction.");
    }
    if (acknowledgedTransaction.schemaVersion !== 0) {
      throw new Error("Expected legacy LangSmith transaction provenance.");
    }
    const expectedSuccessfulThrough = first.queryWindow?.until;
    if (!expectedSuccessfulThrough) {
      throw new Error("Expected a LangSmith query window.");
    }
    expect(acknowledgedTransaction).toMatchObject({
      acknowledgedAt: acknowledgedTransaction.acknowledgedAt,
      checkpoint: {
        advanced: true,
        successfulThroughAfter: expectedSuccessfulThrough,
        successfulThroughBefore: null,
      },
      connectorId: "langsmith",
      connectorStatus: "success",
      query: first.queryWindow,
      rawEvidenceFileCount: first.rawFiles.length,
      reason: "staged-before-transaction-provenance",
      replayed: true,
      runId: first.runId,
      schemaVersion: 0,
    });
    const acknowledgedAt =
      "acknowledgedAt" in acknowledgedTransaction
        ? acknowledgedTransaction.acknowledgedAt
        : "invalid";
    expect(new Date(acknowledgedAt).toISOString()).toBe(acknowledgedAt);
    expect(acknowledgedTransaction).not.toHaveProperty("coverage");
    expect(acknowledgedTransaction).not.toHaveProperty("fetchedAt");
    expect(acknowledgedTransaction).not.toHaveProperty("instanceId");
    expect(acknowledgedTransaction).not.toHaveProperty("project");
    expect(acknowledgedTransaction).not.toHaveProperty("scope");
    expect(Object.values(acknowledgedState.latestIds ?? {})).toContain(
      first.queryWindow?.until,
    );
    expect(Object.values(acknowledgedState.pendingIds ?? {})).toEqual([[]]);
    expect(
      Object.values(acknowledgedState.langsmith?.seenHashes ?? {}),
    ).toHaveLength(1);
  });

  test("preserves staged batches from concurrent connector instances", async () => {
    const home = await createTempHome();
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({ runs: [createRun(1)], truncated: false }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const options = createOptions();

    const results = await Promise.all([
      connector.ingest({ ...options, instanceId: "langsmith-one" }),
      connector.ingest({ ...options, instanceId: "langsmith-two" }),
    ]);

    const stagedState = await readJson<ConnectorStateFile>(getStatePath(home));
    expect(
      Object.keys(stagedState.langsmith?.pendingBatches ?? {}),
    ).toHaveLength(2);
    for (const result of results) {
      await acknowledgeConnector(connector, result);
    }
    const acknowledgedState = await readJson<ConnectorStateFile>(
      getStatePath(home),
    );
    expect(
      Object.keys(
        acknowledgedState.langsmith?.lastAcknowledgedTransactions ?? {},
      ),
    ).toHaveLength(2);
  });

  test("does not checkpoint an explicitly limited pull", async () => {
    const home = await createTempHome();
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({ runs: [createRun(1)], truncated: true }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const result = await connector.ingest({ ...createOptions(), limit: 1 });

    expect(result.status).toBe("success");
    expect(result.warnings.join(" ")).toContain("cursor was not advanced");
    await acknowledgeConnector(connector, result, "no_changes");
    const state = await readJson<ConnectorStateFile>(getStatePath(home));
    expect(state.latestIds).toBeUndefined();
    expect(
      Object.values(state.langsmith?.lastAcknowledgedTransactions ?? {})[0],
    ).toMatchObject({
      acquisition: { windowRootRunsFetched: 1 },
      checkpoint: {
        advanced: false,
        successfulThroughAfter: null,
        successfulThroughBefore: null,
      },
      connectorStatus: "success",
      coverage: { completeWindow: false },
      rawEvidenceFileCount: 2,
      synthesisOutcome: "no_changes",
    });
  });

  test("rejects fractional explicit limits", async () => {
    const home = await createTempHome();
    let queried = false;
    const api = createFakeApi({
      queryRootRuns: () => {
        queried = true;
        return Promise.resolve({ runs: [], truncated: false });
      },
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const result = await createLangSmithConnector({
      createApi: () => api,
    }).ingest({ ...createOptions(), limit: 0.5 });

    expect(result.status).toBe("error");
    expect(result.message).toContain("positive number");
    expect(queried).toBe(false);
  });

  test("records an incomplete no-change transaction without advancing the cursor", async () => {
    const home = await createTempHome();
    let isTruncated = false;
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({ runs: [createRun(1)], truncated: isTruncated }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const options = createOptions();

    const first = await connector.ingest(options);
    await acknowledgeConnector(connector, first);
    const beforeState = await readJson<ConnectorStateFile>(getStatePath(home));
    const [successfulThroughBefore] = Object.values(
      beforeState.latestIds ?? {},
    );
    isTruncated = true;

    const truncated = await connector.ingest({ ...options, limit: 1 });
    expect(truncated).toMatchObject({ rawFiles: [], status: "skipped" });
    await acknowledgeConnector(connector, truncated);

    const state = await readJson<ConnectorStateFile>(getStatePath(home));
    expect(Object.values(state.latestIds ?? {})).toEqual([
      successfulThroughBefore,
    ]);
    expect(
      Object.values(state.langsmith?.lastAcknowledgedTransactions ?? {})[0],
    ).toMatchObject({
      checkpoint: {
        advanced: false,
        successfulThroughAfter: successfulThroughBefore,
        successfulThroughBefore,
      },
      connectorStatus: "skipped",
      coverage: {
        changedLogicalTurns: 0,
        completeWindow: false,
        logicalTurnsEvaluated: 1,
      },
      rawEvidenceFileCount: 0,
      synthesisOutcome: "not_required",
    });
  });

  test("keeps missing pending roots until positively observed terminal", async () => {
    const home = await createTempHome();
    const pending = createRun(1, { status: "pending" });
    const resolved = createRun(1, { status: "success" });
    let queryCount = 0;
    let refreshCount = 0;
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({
          runs: queryCount++ === 0 ? [pending] : [],
          truncated: false,
        }),
      readRuns: (ids) => {
        refreshCount += 1;
        if (ids.length === 0 || refreshCount === 2) {
          return Promise.resolve([]);
        }
        return Promise.resolve([resolved]);
      },
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const options = createOptions();

    const first = await connector.ingest(options);
    expect(first.status).toBe("skipped");
    await acknowledgeConnector(connector, first);

    const missingRefresh = await connector.ingest(options);
    expect(missingRefresh.status).toBe("skipped");
    await acknowledgeConnector(connector, missingRefresh);
    const missingState = await readJson<ConnectorStateFile>(getStatePath(home));
    expect(Object.values(missingState.pendingIds ?? {})).toEqual([
      [pending.id],
    ]);
    expect(
      Object.values(
        missingState.langsmith?.lastAcknowledgedTransactions ?? {},
      )[0],
    ).toMatchObject({
      acquisition: {
        pendingRootIdsCarriedMissing: 1,
        pendingRootIdsRequested: 1,
        pendingRootRunsRefreshed: 0,
        uniqueRootRunsEvaluated: 0,
        windowRootRunsFetched: 0,
      },
      coverage: { pendingRootIdsAfter: 1 },
    });

    const terminal = await connector.ingest(options);
    expect(terminal.status).toBe("success");
    const terminalManifest = await readJson<LangSmithManifest>(
      terminal.rawFiles[0],
    );
    expect(terminalManifest.coverage).toMatchObject({
      logicalTurns: 1,
      pendingRoots: 0,
      rootRunsIncluded: 1,
    });
    await acknowledgeConnector(connector, terminal);
    const finalState = await readJson<ConnectorStateFile>(getStatePath(home));
    expect(Object.values(finalState.pendingIds ?? {})).toEqual([[]]);
    expect(
      Object.values(
        finalState.langsmith?.lastAcknowledgedTransactions ?? {},
      )[0],
    ).toMatchObject({
      acquisition: {
        pendingRootIdsCarriedMissing: 0,
        pendingRootIdsRequested: 1,
        pendingRootRunsRefreshed: 1,
        uniqueRootRunsEvaluated: 1,
        windowRootRunsFetched: 0,
      },
      coverage: { pendingRootIdsAfter: 0 },
    });
  });

  test("emits only new or changed turns from the overlap window", async () => {
    const home = await createTempHome();
    let assistantText = "first version";
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({
          runs: [createRun(1, { assistantText })],
          truncated: false,
        }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const options = createOptions();

    const first = await connector.ingest(options);
    expect(first.status).toBe("success");
    await acknowledgeConnector(connector, first);

    const unchanged = await connector.ingest(options);
    expect(unchanged).toMatchObject({ rawFiles: [], status: "skipped" });
    await acknowledgeConnector(connector, unchanged);
    const unchangedState = await readJson<ConnectorStateFile>(
      getStatePath(home),
    );
    expect(
      Object.values(
        unchangedState.langsmith?.lastAcknowledgedTransactions ?? {},
      )[0],
    ).toMatchObject({
      acquisition: {
        uniqueRootRunsEvaluated: 1,
        windowRootRunsFetched: 1,
      },
      connectorStatus: "skipped",
      coverage: {
        changedLogicalTurns: 0,
        changedTerminalRootRuns: 0,
        changedThreads: 0,
        completeWindow: true,
        logicalTurnsEvaluated: 1,
        threadsEvaluated: 1,
      },
      checkpoint: { advanced: true },
      rawEvidenceFileCount: 0,
      synthesisOutcome: "not_required",
    });

    assistantText = "updated version";
    const changed = await connector.ingest(options);
    expect(changed.status).toBe("success");
    expect(changed.rawFiles).toHaveLength(2);
  });

  test("retains exact acknowledged coverage beyond the capped run history", async () => {
    const home = await createTempHome();
    let queryCount = 0;
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({
          runs: [createRun(1)],
          truncated: false,
        }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({
      createApi: () => api,
      now: () =>
        new Date(Date.parse("2026-07-16T00:00:00.000Z") + queryCount++ * 1000),
    });
    const options = createOptions();

    for (let index = 0; index < 22; index += 1) {
      const result = await connector.ingest(options);
      await acknowledgeConnector(connector, result);
    }

    const state = await readJson<ConnectorStateFile>(getStatePath(home));
    expect(state.runs).toHaveLength(20);
    expect(
      Object.values(state.langsmith?.lastAcknowledgedTransactions ?? {})[0],
    ).toMatchObject({
      connectorStatus: "skipped",
      coverage: {
        changedLogicalTurns: 0,
        logicalTurnsEvaluated: 1,
        threadsEvaluated: 1,
      },
      fetchedAt: "2026-07-16T00:00:21.000Z",
      rawEvidenceFileCount: 0,
    });
  });

  test("segments historical backfills into bounded time windows with overlap", async () => {
    const home = await createTempHome();
    const windows: Array<{ since: string; until: string }> = [];
    const api = createFakeApi({
      queryRootRuns: ({ since, until }) => {
        windows.push({ since, until });
        return Promise.resolve({ runs: [], truncated: false });
      },
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({
      createApi: () => api,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });
    const options = createOptions({
      batchHours: 168,
      overlapHours: 24,
      startTime: "2026-04-01T00:00:00.000Z",
    });

    const first = await connector.ingest(options);
    await acknowledgeConnector(connector, first);
    const second = await connector.ingest(options);

    expect(windows).toEqual([
      {
        since: "2026-04-01T00:00:00.000Z",
        until: "2026-04-08T00:00:00.000Z",
      },
      {
        since: "2026-04-07T00:00:00.000Z",
        until: "2026-04-15T00:00:00.000Z",
      },
    ]);
    expect(second.queryWindow).toEqual(windows[1]);
  });

  test("applies a canonical positive cwd scope before persisting", async () => {
    const home = await createTempHome();
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({
          runs: [
            createRun(1, { cwd: "/Users/alice/project/src" }),
            createRun(2, {
              cwd: "/Users/alice/project/../outside-private",
            }),
            createRun(3, { cwd: "/Users/alice/project-sibling" }),
          ],
          truncated: false,
        }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const result = await createLangSmithConnector({
      createApi: () => api,
    }).ingest(createOptions({ includeCwdPrefixes: ["/Users/alice/project/"] }));
    const manifest = await readJson<LangSmithManifest>(result.rawFiles[0]);

    expect(manifest.coverage).toMatchObject({
      excludedByScope: 2,
      logicalTurns: 1,
      rootRunsIncluded: 1,
    });
    expect(result.warnings.join(" ")).toContain("outside the configured cwd");
  });

  test("scopes checkpoints to endpoint and stable project ID", async () => {
    const home = await createTempHome();
    const windows: string[] = [];
    const api = createFakeApi({
      queryRootRuns: ({ since }) => {
        windows.push(since);
        return Promise.resolve({ runs: [], truncated: false });
      },
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const connector = createLangSmithConnector({ createApi: () => api });
    const base = createOptions({ startTime: "2026-06-01T00:00:00.000Z" });

    const eu = await connector.ingest({
      ...base,
      connectorConfig: {
        ...base.connectorConfig,
        apiUrl: "https://eu.api.smith.langchain.com",
      },
    });
    await acknowledgeConnector(connector, eu);
    await connector.ingest({
      ...base,
      connectorConfig: {
        ...base.connectorConfig,
        apiUrl: "https://api.smith.langchain.com",
      },
    });

    expect(windows).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  test("lets an instance project selector replace the opposite disk selector", async () => {
    const home = await createTempHome();
    const configPath = path.join(
      home,
      ".openwiki/connectors/langsmith/config.json",
    );
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ enabled: true, projectName: "disk-project" })}\n`,
      "utf8",
    );
    let receivedProject: LangSmithProjectSelector | undefined;
    const api = createFakeApi({
      queryRootRuns: ({ project }) => {
        receivedProject = project;
        return Promise.resolve({ runs: [], truncated: false });
      },
      resolveProject: (project) => {
        receivedProject = project;
        return Promise.resolve({ id: "project-id", name: "instance-project" });
      },
    });
    const { createLangSmithConnector } = await loadConnector(home);
    const result = await createLangSmithConnector({
      createApi: () => api,
    }).ingest({ connectorConfig: { projectId: "project-id" } });

    expect(result.status).toBe("skipped");
    expect(receivedProject).toEqual({ projectId: "project-id" });
  });

  test("rejects self-ingestion of OpenWiki's tracing project by default", async () => {
    const home = await createTempHome();
    const api = createFakeApi({
      resolveProject: () =>
        Promise.resolve({ id: "project-id", name: "openwiki-traces" }),
    });
    const { createLangSmithConnector } = await loadConnector(home);
    process.env.LANGCHAIN_PROJECT = "openwiki-traces";
    const result = await createLangSmithConnector({
      createApi: () => api,
    }).ingest(createOptions());

    expect(result.status).toBe("error");
    expect(result.message).toContain("self-ingestion");
  });

  test("rejects untrusted API hosts before constructing a client", async () => {
    const home = await createTempHome();
    let constructed = false;
    const { createLangSmithConnector } = await loadConnector(home);
    const result = await createLangSmithConnector({
      createApi: () => {
        constructed = true;
        return createFakeApi();
      },
    }).ingest(createOptions({ apiUrl: "https://attacker.example" }));

    expect(result.status).toBe("error");
    expect(constructed).toBe(false);
    expect(result.message).toContain("api.smith.langchain.com");
  });

  test("never persists the connector API key", async () => {
    const home = await createTempHome();
    const secret = ["lsv2", "_super-secret-test-value"].join("");
    process.env[API_KEY_ENV] = secret;
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({
          runs: [
            createRun(1, {
              runName: secret,
              userText: `credential ${secret} Bearer also-secret`,
            }),
          ],
          truncated: false,
        }),
    });
    const { createLangSmithConnector } = await loadConnector(home, false);
    const result = await createLangSmithConnector({
      createApi: () => api,
    }).ingest(createOptions());

    const persisted = await readAllJsonText(
      path.join(home, ".openwiki/connectors/langsmith"),
    );
    expect(result.status).toBe("success");
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("also-secret");
    expect(persisted).toContain("[REDACTED:");
  });

  test("sanitizes manifest project identity while using the raw stable project ID for checkpoints", async () => {
    const home = await createTempHome();
    const secret = ["lsv2", "_manifest-project-secret-value"].join("");
    const projectId = "stable-project-id";
    process.env[API_KEY_ENV] = secret;
    const api = createFakeApi({
      queryRootRuns: () =>
        Promise.resolve({ runs: [createRun(1)], truncated: false }),
      resolveProject: () =>
        Promise.resolve({ id: projectId, name: `project-${secret}` }),
    });
    const { createLangSmithConnector } = await loadConnector(home, false);
    const result = await createLangSmithConnector({
      createApi: () => api,
    }).ingest(createOptions());

    const manifest = await readJson<LangSmithManifest>(result.rawFiles[0]);
    const state = await readJson<ConnectorStateFile>(getStatePath(home));
    const checkpointKeys = Object.keys(state.langsmith?.pendingBatches ?? {});

    expect(manifest.project.id).toBe(projectId);
    expect(manifest.project.name).not.toContain(secret);
    expect(manifest.project.name).toContain("[REDACTED:");
    expect(checkpointKeys).toHaveLength(1);
    expect(checkpointKeys[0]).toContain(
      `project:${projectId}:successfulThrough`,
    );
  });
});

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-langsmith-test-"));
  tempHomes.push(home);
  return home;
}

async function loadConnector(home: string, setKey = true) {
  vi.resetModules();
  process.env.HOME = home;
  if (setKey) {
    process.env[API_KEY_ENV] = "lsv2_test-key";
  }
  delete process.env.OPENWIKI_LANGSMITH_ENDPOINT;
  delete process.env.OPENWIKI_INGESTION_SINCE;
  delete process.env.OPENWIKI_INGESTION_UNTIL;
  delete process.env.LANGCHAIN_PROJECT;
  return await import("../src/connectors/sources/langsmith/index.ts");
}

async function acknowledgeConnector(
  connector: Pick<ConnectorRuntime, "acknowledge">,
  result: ConnectorIngestResult,
  synthesisOutcome: ConnectorAcknowledgeResult["synthesisOutcome"] = result.status ===
  "success"
    ? "updated"
    : undefined,
): Promise<void> {
  await connector.acknowledge?.({ ...result, synthesisOutcome });
}

function createFakeApi(overrides: Partial<LangSmithApi> = {}): LangSmithApi {
  return {
    close: () => undefined,
    queryRootRuns: () => Promise.resolve({ runs: [], truncated: false }),
    readRuns: () => Promise.resolve([]),
    resolveProject: (project) =>
      Promise.resolve({
        id: "project-id",
        name:
          "projectName" in project
            ? (project.projectName ?? "agent-project")
            : "agent-project",
      }),
    ...overrides,
  };
}

function createOptions(connectorConfig: Record<string, unknown> = {}) {
  return {
    connectorConfig: {
      enabled: true,
      projectName: "agent-project",
      startTime: "2026-07-15T00:00:00.000Z",
      ...connectorConfig,
    },
    instanceId: "langsmith-1",
  };
}

function createRun(
  index: number,
  options: {
    assistantText?: string;
    cwd?: string;
    runName?: string;
    startTime?: string;
    status?: string;
    threadId?: string;
    userText?: string;
  } = {},
): LangSmithRunRecord {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    app_path: `/o/test/projects/p/test/r/${id}`,
    end_time: "2026-07-15T00:00:01.000Z",
    extra: {
      metadata: {
        agent_name: "codex",
        cwd: options.cwd ?? "/Users/example/project",
        thread_id: options.threadId ?? "thread-1",
        turn_id: `turn-${index}`,
        turn_number: index,
      },
    },
    id,
    inputs: {
      messages: [
        { content: "system prompt", role: "system" },
        { content: options.userText ?? `user ${index}`, role: "user" },
      ],
    },
    name: options.runName ?? "coding-agent-turn",
    outputs: {
      messages: [
        {
          content: options.assistantText ?? `assistant ${index}`,
          role: "assistant",
        },
        { content: "tool payload", role: "tool" },
      ],
    },
    run_type: "chain",
    start_time: options.startTime ?? "2026-07-15T00:00:00.000Z",
    status: options.status ?? "success",
    total_tokens: 10,
    trace_id: id,
  };
}

function getStatePath(home: string): string {
  return path.join(home, ".openwiki/connectors/langsmith/state.json");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readAllJsonText(directory: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readAllJsonText(entryPath));
    } else if (entry.name.endsWith(".json")) {
      chunks.push(await readFile(entryPath, "utf8"));
    }
  }

  return chunks.join("\n");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

type LangSmithManifest = {
  coverage: {
    completeWindow: boolean;
    excludedByScope: number;
    logicalTurns: number;
    pendingRoots: number;
    rootRunsFetched: number;
    rootRunsIncluded: number;
    scope: string;
  };
  project: {
    id: string;
    name: string;
  };
  threads: Array<{ file: string }>;
};

type ConnectorStateFile = {
  langsmith?: {
    lastAcknowledgedTransactions?: Record<
      string,
      | {
          acquisition: {
            pendingRootIdsCarriedMissing: number;
            pendingRootIdsRequested: number;
            pendingRootRunsRefreshed: number;
            uniqueRootRunsEvaluated: number;
            windowRootRunsFetched: number;
          };
          checkpoint: {
            advanced: boolean;
            successfulThroughAfter: string | null;
            successfulThroughBefore: string | null;
          };
          connectorId: "langsmith";
          connectorStatus: "skipped" | "success";
          coverage: {
            changedLogicalTurns: number;
            changedTerminalRootRuns: number;
            changedThreads: number;
            completeWindow: boolean;
            duplicateRootsEvaluated: number;
            excludedByScope: number;
            excludedByTagOrOpenWikiMetadata: number;
            logicalTurnsEvaluated: number;
            pendingRootIdsAfter: number;
            terminalRootRunsEligible: number;
            threadsEvaluated: number;
          };
          endpoint: string;
          fetchedAt: string;
          instanceId: string | null;
          project: { id: string; name: string };
          query: { since: string; until: string };
          rawEvidenceFileCount: number;
          replayed: boolean;
          runId: string;
          schemaVersion: 1;
          scope: {
            excludeTags: string[];
            includeCwdPrefixes: string[];
            kind: "root-runs";
          };
          synthesisOutcome: "no_changes" | "not_required" | "updated";
          warnings: string[];
        }
      | {
          acknowledgedAt: string;
          checkpoint: {
            advanced: boolean;
            successfulThroughAfter: string | null;
            successfulThroughBefore: string | null;
          };
          connectorId: "langsmith";
          connectorStatus: "skipped" | "success";
          query: { since: string; until: string };
          rawEvidenceFileCount: number;
          reason: "staged-before-transaction-provenance";
          replayed: boolean;
          runId: string;
          schemaVersion: 0;
        }
    >;
    pendingBatches?: Record<string, object>;
    seenHashes?: Record<string, Record<string, string>>;
  };
  latestIds?: Record<string, string>;
  pendingIds?: Record<string, string[]>;
  runs?: Array<{
    at: string;
    rawFiles: string[];
    runId: string;
    status: "error" | "skipped" | "success";
    warnings: string[];
  }>;
};

type LegacyConnectorStateFile = {
  langsmith?: {
    pendingBatches?: Record<
      string,
      { selectionKey?: string; transaction?: { schemaVersion: number } }
    >;
  };
};
