import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  ensureConnectorHome,
  getConnectorConfigPath,
  getConnectorDir,
  getConnectorStatePath,
  resolveConnectorRawPath,
} from "../openwiki-home.js";
import type { ConnectorId, ConnectorState } from "./types.js";

const CONNECTOR_LOCK_DIRECTORY = ".mutation-lock";
const CONNECTOR_LOCK_OWNER_FILE = "owner.json";
const CONNECTOR_LOCK_RECOVERY_DIRECTORY = ".recovery";
const DEFAULT_CONNECTOR_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTOR_LOCK_POLL_INTERVAL_MS = 50;
const connectorLockContext = new AsyncLocalStorage<ReadonlySet<ConnectorId>>();

export type ConnectorLockOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
};

type ConnectorLockOwner = {
  createdAt: string;
  pid: number;
  token: string;
};

type ConnectorLockObservation = {
  device: number;
  inode: number;
  owner: ConnectorLockOwner | null;
};

export async function readConnectorConfig<T extends object>(
  connectorId: ConnectorId,
  defaultConfig: T,
): Promise<T> {
  await ensureConnectorHome(connectorId);

  try {
    return {
      ...defaultConfig,
      ...(JSON.parse(
        await readFile(getConnectorConfigPath(connectorId), "utf8"),
      ) as T),
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return defaultConfig;
    }

    throw error;
  }
}

export async function readConnectorState(
  connectorId: ConnectorId,
): Promise<ConnectorState> {
  await ensureConnectorHome(connectorId);

  try {
    return JSON.parse(
      await readFile(getConnectorStatePath(connectorId), "utf8"),
    ) as ConnectorState;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return { version: 1 };
    }

    throw error;
  }
}

export async function writeConnectorState(
  connectorId: ConnectorId,
  state: ConnectorState,
): Promise<void> {
  await ensureConnectorHome(connectorId);
  await writePrivateJson(getConnectorStatePath(connectorId), state);
}

export async function writeRawJson(
  connectorId: ConnectorId,
  runId: string,
  filename: string,
  value: unknown,
): Promise<string> {
  await ensureConnectorHome(connectorId);
  const filePath = resolveConnectorRawPath(
    connectorId,
    path.join(runId, filename),
  );
  await writePrivateJson(filePath, value);

  return filePath;
}

export function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
}

export async function withConnectorLock<TResult>(
  connectorId: ConnectorId,
  operation: () => Promise<TResult>,
  options: ConnectorLockOptions = {},
): Promise<TResult> {
  const heldLocks = connectorLockContext.getStore();
  if (heldLocks?.has(connectorId)) {
    return await operation();
  }

  await ensureConnectorHome(connectorId);
  const lockDirectory = path.join(
    getConnectorDir(connectorId),
    CONNECTOR_LOCK_DIRECTORY,
  );
  const timeoutMs = normalizeLockDuration(
    options.timeoutMs,
    DEFAULT_CONNECTOR_LOCK_TIMEOUT_MS,
    "timeoutMs",
  );
  const pollIntervalMs = normalizeLockDuration(
    options.pollIntervalMs,
    DEFAULT_CONNECTOR_LOCK_POLL_INTERVAL_MS,
    "pollIntervalMs",
    false,
  );
  const owner: ConnectorLockOwner = {
    createdAt: new Date().toISOString(),
    pid: process.pid,
    token: randomUUID(),
  };
  const deadline = Date.now() + timeoutMs;

  while (!(await tryAcquireConnectorLock(lockDirectory, owner))) {
    if (await tryRecoverStaleConnectorLock(lockDirectory)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the ${connectorId} connector mutation lock after ${timeoutMs}ms.`,
      );
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  try {
    return await connectorLockContext.run(
      new Set([...(heldLocks ?? []), connectorId]),
      operation,
    );
  } finally {
    await releaseConnectorLock(lockDirectory, owner.token);
  }
}

export function updateStateWithRun(
  state: ConnectorState,
  run: NonNullable<ConnectorState["runs"]>[number],
): ConnectorState {
  return {
    ...state,
    lastRunAt: run.at,
    runs: [run, ...(state.runs ?? [])].slice(0, 20),
    version: 1,
  };
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fileHandle = await open(temporaryPath, "wx", 0o600);
    await fileHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function tryAcquireConnectorLock(
  lockDirectory: string,
  owner: ConnectorLockOwner,
): Promise<boolean> {
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return false;
    }
    throw error;
  }

  try {
    await writePrivateJson(
      path.join(lockDirectory, CONNECTOR_LOCK_OWNER_FILE),
      owner,
    );
    return true;
  } catch (error) {
    await rm(lockDirectory, { force: true, recursive: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function tryRecoverStaleConnectorLock(
  lockDirectory: string,
): Promise<boolean> {
  const observation = await observeConnectorLock(lockDirectory);
  if (!observation || !isStaleConnectorLock(observation)) {
    return false;
  }

  const recoveryDirectory = path.join(
    lockDirectory,
    CONNECTOR_LOCK_RECOVERY_DIRECTORY,
  );
  try {
    await mkdir(recoveryDirectory, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExistsError(error) || isFileNotFoundError(error)) {
      return false;
    }
    throw error;
  }

  let recovered = false;
  try {
    const current = await observeConnectorLock(lockDirectory);
    if (
      !current ||
      current.device !== observation.device ||
      current.inode !== observation.inode ||
      current.owner?.token !== observation.owner?.token ||
      !isStaleConnectorLock(current)
    ) {
      return false;
    }

    await rm(lockDirectory, { recursive: true });
    recovered = true;
    return true;
  } finally {
    if (!recovered) {
      await rm(recoveryDirectory, { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  }
}

async function releaseConnectorLock(
  lockDirectory: string,
  ownerToken: string,
): Promise<void> {
  const owner = await readConnectorLockOwner(lockDirectory);
  if (owner?.token !== ownerToken) {
    throw new Error(
      "Connector mutation lock ownership changed before it could be released.",
    );
  }

  await rm(lockDirectory, { recursive: true });
}

async function observeConnectorLock(
  lockDirectory: string,
): Promise<ConnectorLockObservation | null> {
  try {
    const lockStat = await stat(lockDirectory);
    return {
      device: lockStat.dev,
      inode: lockStat.ino,
      owner: await readConnectorLockOwner(lockDirectory),
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readConnectorLockOwner(
  lockDirectory: string,
): Promise<ConnectorLockOwner | null> {
  try {
    const value = JSON.parse(
      await readFile(
        path.join(lockDirectory, CONNECTOR_LOCK_OWNER_FILE),
        "utf8",
      ),
    ) as Partial<ConnectorLockOwner>;
    return typeof value.createdAt === "string" &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string" &&
      value.token.length > 0
      ? {
          createdAt: value.createdAt,
          pid: value.pid,
          token: value.token,
        }
      : null;
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isStaleConnectorLock(observation: ConnectorLockObservation): boolean {
  // An ownerless or malformed lock is never safe to remove: its creator may
  // still be alive in the small window between mkdir and writing owner.json.
  return observation.owner ? !isProcessAlive(observation.owner.pid) : false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function normalizeLockDuration(
  value: number | undefined,
  fallback: number,
  label: string,
  allowZero = true,
): number {
  if (value === undefined) {
    return fallback;
  }
  const minimum = allowZero ? 0 : 1;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new Error(
      `Connector lock ${label} must be ${allowZero ? "a non-negative" : "a positive"} integer.`,
    );
  }
  return value;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
