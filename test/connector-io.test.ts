import { spawn } from "node:child_process";
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
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("connector JSON persistence", () => {
  test("writes private state atomically and leaves valid JSON under concurrent replacement", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);

    await Promise.all([
      io.writeConnectorState("langsmith", {
        latestIds: { cursor: "one" },
        version: 1,
      }),
      io.writeConnectorState("langsmith", {
        latestIds: { cursor: "two" },
        version: 1,
      }),
    ]);

    const statePath = path.join(
      home,
      ".openwiki/connectors/langsmith/state.json",
    );
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
      latestIds: { cursor: string };
    };
    expect(["one", "two"]).toContain(parsed.latestIds.cursor);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  test("rejects raw filenames that escape the connector directory", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);

    await expect(
      io.writeRawJson("langsmith", "run", "../../../escape.json", {}),
    ).rejects.toThrow("must stay inside");
  });

  test("serializes connector mutations across processes", async () => {
    const home = await createTempHome();
    const eventPath = path.join(home, "lock-events.txt");

    await Promise.all([
      runLockWorker(home, eventPath, "first"),
      runLockWorker(home, eventPath, "second"),
    ]);

    const events = (await readFile(eventPath, "utf8")).trim().split("\n");
    const firstOwner = events[0]?.split(":")[0];
    const secondOwner = events[2]?.split(":")[0];
    expect(events).toEqual([
      `${firstOwner}:start`,
      `${firstOwner}:end`,
      `${secondOwner}:start`,
      `${secondOwner}:end`,
    ]);
    expect(firstOwner).not.toBe(secondOwner);
  });

  test("allows the same async workflow to re-enter its connector lock", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);

    await expect(
      io.withConnectorLock("langsmith", () =>
        io.withConnectorLock("langsmith", () => Promise.resolve("nested"), {
          pollIntervalMs: 1,
          timeoutMs: 10,
        }),
      ),
    ).resolves.toBe("nested");
  });

  test("recovers a dead lock owner", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);
    const lockDirectory = getLockDirectory(home);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        createdAt: "2026-01-01T00:00:00.000Z",
        pid: 2_147_483_647,
        token: "dead-owner",
      })}\n`,
      "utf8",
    );

    await expect(
      io.withConnectorLock("langsmith", () => Promise.resolve("recovered"), {
        pollIntervalMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toBe("recovered");
  });

  test("never removes a lock held by a live process", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);
    const lockDirectory = getLockDirectory(home);
    const owner = {
      createdAt: "2020-01-01T00:00:00.000Z",
      pid: process.pid,
      token: "live-owner",
    };
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify(owner)}\n`,
      "utf8",
    );

    await expect(
      io.withConnectorLock("langsmith", () => Promise.resolve(), {
        pollIntervalMs: 1,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting");
    expect(
      JSON.parse(
        await readFile(path.join(lockDirectory, "owner.json"), "utf8"),
      ),
    ).toEqual(owner);
  });

  test("never removes an ownerless lock that may still be initializing", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);
    const lockDirectory = getLockDirectory(home);
    await mkdir(lockDirectory, { recursive: true });

    await expect(
      io.withConnectorLock("langsmith", () => Promise.resolve(), {
        pollIntervalMs: 1,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting");
    await expect(stat(lockDirectory)).resolves.toBeDefined();
  });

  test("creates collision-resistant run IDs at the same timestamp", async () => {
    const home = await createTempHome();
    const io = await loadIo(home);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));

    const first = io.createRunId();
    const second = io.createRunId();

    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^2026-07-16T00-00-00-000Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });
});

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-io-test-"));
  tempHomes.push(home);
  return home;
}

async function loadIo(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  return await import("../src/connectors/io.ts");
}

function getLockDirectory(home: string): string {
  return path.join(home, ".openwiki/connectors/langsmith/.mutation-lock");
}

async function runLockWorker(
  home: string,
  eventPath: string,
  workerName: string,
): Promise<void> {
  const ioUrl = pathToFileURL(path.resolve("src/connectors/io.ts")).href;
  const source = `
    import { appendFile } from "node:fs/promises";
    const { withConnectorLock } = await import(${JSON.stringify(ioUrl)});
    await withConnectorLock("langsmith", async () => {
      await appendFile(${JSON.stringify(eventPath)}, ${JSON.stringify(`${workerName}:start\n`)}, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 75));
      await appendFile(${JSON.stringify(eventPath)}, ${JSON.stringify(`${workerName}:end\n`)}, "utf8");
    });
  `;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: path.resolve("."),
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Lock worker ${workerName} failed (${signal ?? code ?? "unknown"}): ${stderr}`,
        ),
      );
    });
  });
}
