import { beforeEach, describe, expect, test, vi } from "vitest";

type MockRun = {
  id: string;
  inputs: { messages: never[] };
  name: string;
  run_type: string;
  start_time: string;
};

type MockProject = { id: string; name?: string };

const clientMock = vi.hoisted(() => ({
  cleanup: vi.fn<() => void>(),
  constructorArgs: [] as Array<{ apiKey: string; apiUrl: string }>,
  listRuns: vi.fn<(input: Record<string, unknown>) => AsyncIterable<MockRun>>(),
  readProject:
    vi.fn<(input: Record<string, unknown>) => Promise<MockProject>>(),
}));

vi.mock("langsmith", () => ({
  Client: class {
    constructor(options: { apiKey: string; apiUrl: string }) {
      clientMock.constructorArgs.push(options);
    }

    cleanup() {
      clientMock.cleanup();
    }

    listRuns(input: Record<string, unknown>): AsyncIterable<MockRun> {
      return clientMock.listRuns(input);
    }

    readProject(input: Record<string, unknown>): Promise<MockProject> {
      return clientMock.readProject(input);
    }
  },
}));

const { createLangSmithApi, normalizeLangSmithApiUrl } =
  await import("../src/connectors/sources/langsmith/api.ts");

const EXPECTED_RUN_SELECT = [
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

beforeEach(() => {
  clientMock.cleanup.mockReset();
  clientMock.constructorArgs.length = 0;
  clientMock.listRuns.mockReset();
  clientMock.readProject.mockReset();
});

describe("LangSmith SDK adapter", () => {
  test("requests one extra root run and reports truncation only when it exists", async () => {
    clientMock.listRuns.mockReturnValue(
      asAsyncIterable([
        createRun("run-1"),
        createRun("run-2"),
        createRun("run-3"),
      ]),
    );
    const api = createLangSmithApi(
      "https://eu.api.smith.langchain.com",
      "test-key",
    );

    const result = await api.queryRootRuns({
      limit: 2,
      project: { projectName: "example-project" },
      since: "2026-07-15T00:00:00.000Z",
      until: "2026-07-16T00:00:00.000Z",
    });

    expect(clientMock.listRuns).toHaveBeenCalledWith({
      filter: 'lt(start_time, "2026-07-16T00:00:00.000Z")',
      isRoot: true,
      limit: 3,
      order: "asc",
      projectName: "example-project",
      select: EXPECTED_RUN_SELECT,
      startTime: new Date("2026-07-15T00:00:00.000Z"),
    });
    expect(result.runs.map((run) => run.id)).toEqual(["run-1", "run-2"]);
    expect(result.truncated).toBe(true);
  });

  test("does not report truncation when a bounded pull has no extra run", async () => {
    clientMock.listRuns.mockReturnValue(
      asAsyncIterable([createRun("run-1"), createRun("run-2")]),
    );
    const api = createLangSmithApi(
      "https://api.smith.langchain.com",
      "test-key",
    );

    const result = await api.queryRootRuns({
      limit: 2,
      project: { projectId: "project-id" },
      since: "2026-07-15T00:00:00.000Z",
      until: "2026-07-16T00:00:00.000Z",
    });

    expect(clientMock.listRuns).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, projectId: "project-id" }),
    );
    expect(result.runs.map((run) => run.id)).toEqual(["run-1", "run-2"]);
    expect(result.truncated).toBe(false);
  });

  test("exhausts the SDK async iterable when no explicit limit is provided", async () => {
    const runs = Array.from({ length: 205 }, (_, index) =>
      createRun(`run-${index + 1}`),
    );
    clientMock.listRuns.mockReturnValue(asAsyncIterable(runs));
    const api = createLangSmithApi(
      "https://api.smith.langchain.com",
      "test-key",
    );

    const result = await api.queryRootRuns({
      project: { projectName: "example-project" },
      since: "2026-07-15T00:00:00.000Z",
      until: "2026-07-16T00:00:00.000Z",
    });

    expect(result.runs).toHaveLength(205);
    expect(result.truncated).toBe(false);
    expect(clientMock.listRuns.mock.calls[0]?.[0]).not.toHaveProperty("limit");
  });

  test("reads the requested run IDs with the compact select projection", async () => {
    const api = createLangSmithApi(
      "https://api.smith.langchain.com",
      "test-key",
    );

    await expect(api.readRuns([])).resolves.toEqual([]);
    expect(clientMock.listRuns).not.toHaveBeenCalled();

    clientMock.listRuns.mockReturnValue(
      asAsyncIterable([createRun("run-2"), createRun("run-1")]),
    );
    const runs = await api.readRuns(["run-1", "run-2"]);

    expect(clientMock.listRuns).toHaveBeenCalledWith({
      id: ["run-1", "run-2"],
      select: EXPECTED_RUN_SELECT,
    });
    expect(runs.map((run) => run.id)).toEqual(["run-2", "run-1"]);
  });

  test("resolves project names and IDs to the server's stable identity", async () => {
    clientMock.readProject
      .mockResolvedValueOnce({ id: "project-id", name: "example-project" })
      .mockResolvedValueOnce({ id: "project-id", name: "renamed-project" });
    const api = createLangSmithApi(
      "https://api.smith.langchain.com",
      "test-key",
    );

    await expect(
      api.resolveProject({ projectName: "example-project" }),
    ).resolves.toEqual({ id: "project-id", name: "example-project" });
    await expect(
      api.resolveProject({ projectId: "project-id" }),
    ).resolves.toEqual({ id: "project-id", name: "renamed-project" });
    expect(clientMock.readProject).toHaveBeenNthCalledWith(1, {
      projectName: "example-project",
    });
    expect(clientMock.readProject).toHaveBeenNthCalledWith(2, {
      projectId: "project-id",
    });
  });

  test("rejects a project response without a stable name", async () => {
    clientMock.readProject.mockResolvedValue({ id: "project-id" });
    const api = createLangSmithApi(
      "https://api.smith.langchain.com",
      "test-key",
    );

    await expect(
      api.resolveProject({ projectId: "project-id" }),
    ).rejects.toThrow("did not include a project name");
  });

  test("allows only the official US and EU endpoints and cleans up the client", () => {
    expect(normalizeLangSmithApiUrl("https://api.smith.langchain.com/")).toBe(
      "https://api.smith.langchain.com",
    );
    expect(normalizeLangSmithApiUrl("https://eu.api.smith.langchain.com")).toBe(
      "https://eu.api.smith.langchain.com",
    );

    const api = createLangSmithApi(
      "https://eu.api.smith.langchain.com/",
      "test-key",
    );
    expect(clientMock.constructorArgs).toEqual([
      {
        apiKey: "test-key",
        apiUrl: "https://eu.api.smith.langchain.com",
      },
    ]);

    api.close();
    expect(clientMock.cleanup).toHaveBeenCalledOnce();
  });

  test.each([
    "not a URL",
    "http://api.smith.langchain.com",
    "https://attacker.example",
    "https://api.smith.langchain.com/v1",
    "https://user@api.smith.langchain.com",
    "https://api.smith.langchain.com?token=secret",
    "https://api.smith.langchain.com#fragment",
  ])(
    "rejects an untrusted endpoint before constructing a client: %s",
    (apiUrl) => {
      expect(() => createLangSmithApi(apiUrl, "test-key")).toThrow(
        /LangSmith apiUrl/u,
      );
      expect(clientMock.constructorArgs).toEqual([]);
    },
  );
});

function createRun(id: string): MockRun {
  return {
    id,
    inputs: { messages: [] },
    name: "agent-run",
    run_type: "chain",
    start_time: "2026-07-15T00:00:00.000Z",
  };
}

function asAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (index >= items.length) {
            return Promise.resolve({ done: true, value: undefined });
          }

          const value = items[index];
          index += 1;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}
