import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { constants as fsConstants } from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  getConnectorConfigPath,
  getConnectorRawDir,
  openWikiHomeDir,
  openWikiLocalWikiDir,
  resolveConnectorRawPath,
} from "../openwiki-home.js";
import { createConnectorRegistry, isConnectorId } from "./registry.js";
import {
  callMcpConnectorTool,
  discoverMcpConnectorTools,
  isMcpConnectorId,
} from "./mcp-runtime.js";
import type {
  ConnectorId,
  ConnectorIngestOptions,
  ConnectorSourceUpdate,
  ConnectorSourceUpdateReceipt,
} from "./types.js";

type OpenWikiConnectorToolOptions = {
  onSourceUpdateReceipt?: (receipt: ConnectorSourceUpdateReceipt) => void;
  sourceUpdate?: ConnectorSourceUpdate;
};

type RawItemReadResult = {
  connectorId: ConnectorId;
  content: string;
  filePath: string;
  nextOffsetCharacters: number | null;
  offsetCharacters: number;
  totalCharacters: number | null;
  truncated: boolean;
};

type RawItemCursorState = {
  byteOffsetsByCharacter: Map<number, number>;
  fileIdentity: string;
  totalCharacters: number | null;
};

type Utf8Page = {
  content: string;
  endByteOffset: number;
  isEndOfFile: boolean;
};

type ReadRange = {
  end: number;
  start: number;
};

// DeepAgents offloads tool results above roughly 80k characters before the
// model sees them. Keep each JSON-encoded page comfortably below that boundary;
// offset paging remains unbounded across the complete file.
const RAW_ITEM_PAGE_MAX_CHARACTERS = 20_000;
const RAW_ITEM_READ_CHUNK_MAX_BYTES = 64 * 1024;

export function createOpenWikiConnectorTools(
  options: OpenWikiConnectorToolOptions = {},
): StructuredToolInterface[] {
  const readRawItem = createRawItemReader();
  const sourceUpdateTracker = options.sourceUpdate
    ? createSourceUpdateReceiptTracker(options.sourceUpdate)
    : null;
  const tools = [
    new DynamicStructuredTool({
      name: "openwiki_list_connectors",
      description:
        "List built-in OpenWiki connectors, their backends, required env var names, config paths, and raw data paths. Secret values are never returned.",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
      func: async () => stringifyToolResult(await listConnectors()),
    }),
    new DynamicStructuredTool({
      name: "openwiki_list_mcp_tools",
      description:
        'List live MCP tools for a configured MCP connector and write discovery under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"notion"}. Use exact returned tool names.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: ["notion"],
          },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await listMcpToolsForConnector(getConnectorId(input, "connectorId")),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_call_mcp_tool",
      description:
        'Call one exact discovered read-only MCP tool and write the result under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"notion","toolName":"exact_tool_name","args":{"query":"Applied AI"}}.',
      schema: {
        type: "object",
        properties: {
          args: {
            type: "object",
            additionalProperties: true,
          },
          connectorId: {
            type: "string",
            enum: ["notion"],
          },
          toolName: {
            type: "string",
          },
        },
        required: ["connectorId", "toolName"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await callMcpToolForConnector(
            getConnectorId(input, "connectorId"),
            getStringInput(input, "toolName"),
            getRecordInput(input, "args") ?? {},
          ),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_ingest_connector",
      description:
        'Run deterministic ingestion for one built-in connector and write raw data/manifests under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"x","streams":["bookmarks"],"limit":1}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: [
              "git-repo",
              "google",
              "hackernews",
              "langsmith",
              "notion",
              "slack",
              "web-search",
              "x",
            ],
          },
          limit: { type: "number" },
          streams: {
            type: "array",
            items: { type: "string" },
          },
          windowHours: { type: "number" },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await ingestConnector(
            getConnectorId(input, "connectorId"),
            getIngestOptions(input),
          ),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_ingest_all_connectors",
      description:
        "Run deterministic ingestion for all configured built-in connectors. Connectors that are not configured or enabled are skipped.",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
      func: async () => stringifyToolResult(await ingestAllConnectors()),
    }),
    new DynamicStructuredTool({
      name: "openwiki_list_raw_items",
      description:
        'List raw files for a connector under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"x"}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: [
              "git-repo",
              "google",
              "hackernews",
              "langsmith",
              "notion",
              "slack",
              "web-search",
              "x",
            ],
          },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await listRawItems(getConnectorId(input, "connectorId")),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_read_raw_item",
      description:
        'Read a raw connector file by connector ID and relative path. Only files inside ~/.openwiki/connectors/<id>/raw are allowed. Page long files with the exact returned nextOffsetCharacters; do not calculate offsets from content length. totalCharacters is null until the page reaches EOF. Input: {"connectorId":"x","path":"2026-.../bookmarks.json","maxBytes":50000,"offsetCharacters":0}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: [
              "git-repo",
              "google",
              "hackernews",
              "langsmith",
              "notion",
              "slack",
              "web-search",
              "x",
            ],
          },
          maxBytes: {
            description:
              "Legacy name for the requested UTF-16 character page size; capped at 20,000.",
            type: "number",
          },
          offsetCharacters: {
            description:
              "UTF-16 cursor. Start at 0, then use the exact nextOffsetCharacters returned by the preceding page.",
            type: "number",
          },
          path: {
            type: "string",
          },
        },
        required: ["connectorId", "path"],
        additionalProperties: false,
      } as const,
      func: async (input) => {
        const connectorId = getConnectorId(input, "connectorId");
        const relativePath = getStringInput(input, "path");
        sourceUpdateTracker?.assertAllowed(connectorId, relativePath);
        const result = await readRawItem(
          connectorId,
          relativePath,
          getNumberInput(input, "maxBytes") ?? RAW_ITEM_PAGE_MAX_CHARACTERS,
          getNumberInput(input, "offsetCharacters") ?? 0,
        );
        sourceUpdateTracker?.recordRead(result);
        return stringifyToolResult(result);
      },
    }),
  ];

  if (!sourceUpdateTracker) {
    return tools;
  }

  return [
    ...tools.filter((tool) => tool.name === "openwiki_read_raw_item"),
    createCompleteSourceUpdateTool(
      sourceUpdateTracker,
      options.onSourceUpdateReceipt,
    ),
  ];
}

function createCompleteSourceUpdateTool(
  tracker: ReturnType<typeof createSourceUpdateReceiptTracker>,
  onReceipt: ((receipt: ConnectorSourceUpdateReceipt) => void) | undefined,
): StructuredToolInterface {
  return new DynamicStructuredTool({
    name: "openwiki_complete_source_update",
    description:
      "Complete the current deterministic source update only after every required raw file has been read in full and synthesis is finished. Use outcome=updated after durable wiki changes, or outcome=no_changes when the evidence contains no new durable knowledge.",
    schema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["no_changes", "updated"],
        },
        summary: {
          type: "string",
        },
      },
      required: ["outcome", "summary"],
      additionalProperties: false,
    } as const,
    func: (input) => {
      const outcome = getSourceUpdateOutcome(input, "outcome");
      const receipt = tracker.complete(
        outcome,
        getStringInput(input, "summary"),
      );
      onReceipt?.(receipt);
      return Promise.resolve(
        stringifyToolResult({ completed: true, ...receipt }),
      );
    },
  });
}

export function createSourceUpdateReceiptTracker(
  sourceUpdate: ConnectorSourceUpdate,
) {
  const rawDir = path.resolve(getConnectorRawDir(sourceUpdate.connectorId));
  const requiredFiles = new Map(
    sourceUpdate.rawFiles.map((filePath) => {
      const resolved = path.resolve(filePath);
      if (!isPathInside(rawDir, resolved)) {
        throw new Error(
          `Source update raw file must stay inside ${sourceUpdate.connectorId}'s raw directory.`,
        );
      }
      return [resolved, path.relative(rawDir, resolved)] as const;
    }),
  );
  const readRanges = new Map<string, ReadRange[]>();
  const totalCharacters = new Map<string, number>();
  let receipt: ConnectorSourceUpdateReceipt | undefined;

  return {
    assertAllowed(connectorId: ConnectorId, relativePath: string): void {
      if (connectorId !== sourceUpdate.connectorId) {
        throw new Error(
          `This source update may only read raw files for ${sourceUpdate.connectorId}.`,
        );
      }
      const resolved = path.resolve(
        resolveConnectorRawPath(connectorId, relativePath),
      );
      if (!requiredFiles.has(resolved)) {
        throw new Error(
          "This source update may only read the exact raw files declared by its deterministic pull.",
        );
      }
    },
    complete(
      outcome: ConnectorSourceUpdateReceipt["outcome"],
      summary: string,
    ): ConnectorSourceUpdateReceipt {
      const missingFiles = [...requiredFiles].filter(([filePath]) => {
        const ranges = mergeReadRanges(readRanges.get(filePath) ?? []);
        const total = totalCharacters.get(filePath);
        return total === undefined || !coversWholeFile(ranges, total);
      });
      if (missingFiles.length > 0) {
        throw new Error(
          `Cannot complete source update before reading every raw file in full: ${missingFiles
            .map(([, relativePath]) => relativePath)
            .join(", ")}`,
        );
      }

      const normalizedSummary = summary.trim();
      if (!normalizedSummary) {
        throw new Error("Source update completion summary must not be empty.");
      }

      receipt = {
        connectorId: sourceUpdate.connectorId,
        outcome,
        rawFilesRead: [...requiredFiles.values()].sort(),
        summary: normalizedSummary,
      };
      return receipt;
    },
    getReceipt(): ConnectorSourceUpdateReceipt | undefined {
      return receipt;
    },
    recordRead(result: RawItemReadResult): void {
      if (result.connectorId !== sourceUpdate.connectorId) {
        return;
      }
      const resolved = path.resolve(result.filePath);
      if (!requiredFiles.has(resolved)) {
        return;
      }
      const ranges = readRanges.get(resolved) ?? [];
      const end =
        result.nextOffsetCharacters ??
        (result.truncated ? null : result.totalCharacters);
      if (end === null) {
        return;
      }
      ranges.push({
        end,
        start: result.offsetCharacters,
      });
      readRanges.set(resolved, ranges);
      if (!result.truncated && result.totalCharacters !== null) {
        totalCharacters.set(resolved, result.totalCharacters);
      }
    },
  };
}

async function listConnectors() {
  const registry = createConnectorRegistry();
  const connectors = [];

  for (const connector of Object.values(registry)) {
    const configPath = getConnectorConfigPath(connector.id);
    const configExists = await pathExists(configPath);
    const requiredEnvStatus = connector.requiredEnv.map((key) => ({
      key,
      set: Boolean(process.env[key]),
    }));
    const allRequiredEnvSet = requiredEnvStatus.every((env) => env.set);

    connectors.push({
      authConfigured: connector.requiredEnv.length === 0 || allRequiredEnvSet,
      backend: connector.backend,
      configExists,
      configPath,
      description: connector.description,
      displayName: connector.displayName,
      id: connector.id,
      rawDir: getConnectorRawDir(connector.id),
      readyForIngestion: configExists && allRequiredEnvSet,
      requiredEnv: connector.requiredEnv,
      requiredEnvStatus,
      supportsAgenticDiscovery: connector.supportsAgenticDiscovery,
    });
  }

  return {
    note: "Secret values are never returned. requiredEnvStatus reports presence only.",
    homeDir: openWikiHomeDir,
    wikiDir: openWikiLocalWikiDir,
    connectors,
  };
}

async function ingestConnector(
  connectorId: ConnectorId,
  options: ConnectorIngestOptions,
) {
  const registry = createConnectorRegistry();

  return registry[connectorId].ingest(options);
}

async function listMcpToolsForConnector(connectorId: ConnectorId) {
  if (!isMcpConnectorId(connectorId)) {
    throw new Error(`Connector ${connectorId} is not MCP-backed.`);
  }

  return await discoverMcpConnectorTools(connectorId);
}

async function callMcpToolForConnector(
  connectorId: ConnectorId,
  toolName: string,
  args: Record<string, unknown>,
) {
  if (!isMcpConnectorId(connectorId)) {
    throw new Error(`Connector ${connectorId} is not MCP-backed.`);
  }

  return await callMcpConnectorTool(connectorId, toolName, args);
}

async function ingestAllConnectors() {
  const registry = createConnectorRegistry();
  const results = [];

  for (const connector of Object.values(registry)) {
    results.push(await connector.ingest());
  }

  return {
    results,
  };
}

async function listRawItems(connectorId: ConnectorId) {
  const rawDir = getConnectorRawDir(connectorId);
  const files = await listFiles(rawDir, rawDir);
  const latestRunId = getLatestRunId(files);

  return {
    connectorId,
    files,
    latestFiles:
      latestRunId === null
        ? []
        : files.filter((file) => file.startsWith(`${latestRunId}/`)),
    latestRunId,
    note: "Files are sorted newest run first so agents should prefer latestFiles for current answers.",
    rawDir,
  };
}

function createRawItemReader() {
  const cursorStates = new Map<string, RawItemCursorState>();

  return async function readRawItem(
    connectorId: ConnectorId,
    relativePath: string,
    maxBytes: number,
    offsetCharacters: number,
  ): Promise<RawItemReadResult> {
    const filePath = resolveConnectorRawPath(connectorId, relativePath);
    const fileHandle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );

    try {
      const fileStat = await fileHandle.stat();

      if (!fileStat.isFile()) {
        throw new Error("Raw item path must point to a file.");
      }

      const fileIdentity = [
        fileStat.dev,
        fileStat.ino,
        fileStat.size,
        fileStat.mtimeMs,
      ].join(":");
      const cachedState = cursorStates.get(filePath);
      const state =
        cachedState?.fileIdentity === fileIdentity
          ? cachedState
          : {
              byteOffsetsByCharacter: new Map([[0, 0]]),
              fileIdentity,
              totalCharacters: null,
            };
      cursorStates.set(filePath, state);

      const requestedOffset = Math.max(0, Math.trunc(offsetCharacters));
      const offset = await resolveCharacterOffset({
        fileHandle,
        fileSize: fileStat.size,
        requestedOffset,
        state,
      });
      const startByteOffset = state.byteOffsetsByCharacter.get(offset);
      if (startByteOffset === undefined) {
        throw new Error("Raw item cursor could not be resolved.");
      }

      const limit = Math.max(
        1,
        Math.min(Math.trunc(maxBytes), RAW_ITEM_PAGE_MAX_CHARACTERS),
      );
      const page = await readUtf8Page({
        fileHandle,
        fileSize: fileStat.size,
        maxCharacters: limit,
        startByteOffset,
      });
      const nextOffset = offset + page.content.length;
      state.byteOffsetsByCharacter.set(nextOffset, page.endByteOffset);
      if (page.isEndOfFile) {
        state.totalCharacters = nextOffset;
      }

      const currentFileStat = await fileHandle.stat();
      const currentFileIdentity = [
        currentFileStat.dev,
        currentFileStat.ino,
        currentFileStat.size,
        currentFileStat.mtimeMs,
      ].join(":");
      if (currentFileIdentity !== fileIdentity) {
        cursorStates.delete(filePath);
        throw new Error("Raw item changed while it was being read; retry.");
      }

      return {
        connectorId,
        content: page.content,
        filePath,
        nextOffsetCharacters: page.isEndOfFile ? null : nextOffset,
        offsetCharacters: offset,
        totalCharacters: page.isEndOfFile ? nextOffset : null,
        truncated: !page.isEndOfFile,
      };
    } finally {
      await fileHandle.close();
    }
  };
}

async function resolveCharacterOffset(options: {
  fileHandle: FileHandle;
  fileSize: number;
  requestedOffset: number;
  state: RawItemCursorState;
}): Promise<number> {
  const { fileHandle, fileSize, requestedOffset, state } = options;
  if (
    state.totalCharacters !== null &&
    requestedOffset >= state.totalCharacters
  ) {
    return state.totalCharacters;
  }
  if (state.byteOffsetsByCharacter.has(requestedOffset)) {
    return requestedOffset;
  }

  let characterOffset = 0;
  for (const knownOffset of state.byteOffsetsByCharacter.keys()) {
    if (knownOffset < requestedOffset && knownOffset > characterOffset) {
      characterOffset = knownOffset;
    }
  }
  let byteOffset = state.byteOffsetsByCharacter.get(characterOffset) ?? 0;

  while (characterOffset < requestedOffset) {
    const charactersRemaining = requestedOffset - characterOffset;
    const page = await readUtf8Page({
      fileHandle,
      fileSize,
      maxCharacters: Math.min(
        charactersRemaining,
        RAW_ITEM_PAGE_MAX_CHARACTERS,
      ),
      startByteOffset: byteOffset,
    });
    const nextCharacterOffset = characterOffset + page.content.length;
    if (nextCharacterOffset > requestedOffset) {
      throw new Error(
        "offsetCharacters splits a Unicode character; use an exact nextOffsetCharacters value returned by this tool.",
      );
    }
    characterOffset = nextCharacterOffset;
    byteOffset = page.endByteOffset;
    state.byteOffsetsByCharacter.set(characterOffset, byteOffset);

    if (page.isEndOfFile) {
      state.totalCharacters = characterOffset;
      return characterOffset;
    }
    if (page.content.length === 0) {
      throw new Error("Raw item cursor did not advance.");
    }
  }

  return characterOffset;
}

async function readUtf8Page(options: {
  fileHandle: FileHandle;
  fileSize: number;
  maxCharacters: number;
  startByteOffset: number;
}): Promise<Utf8Page> {
  const { fileHandle, fileSize, maxCharacters, startByteOffset } = options;
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  let decoded = "";
  let readPosition = startByteOffset;

  while (decoded.length < maxCharacters && readPosition < fileSize) {
    const bytesRemaining = fileSize - readPosition;
    const buffer = Buffer.allocUnsafe(
      Math.min(bytesRemaining, RAW_ITEM_READ_CHUNK_MAX_BYTES),
    );
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      buffer.length,
      readPosition,
    );
    if (bytesRead === 0) {
      throw new Error("Raw item ended before its reported file size.");
    }
    readPosition += bytesRead;
    decoded += decoder.decode(buffer.subarray(0, bytesRead), {
      stream: readPosition < fileSize,
    });
  }

  const content = takeUtf16SafePrefix(decoded, maxCharacters);
  const endByteOffset = startByteOffset + Buffer.byteLength(content, "utf8");

  return {
    content,
    endByteOffset,
    isEndOfFile: endByteOffset === fileSize,
  };
}

function takeUtf16SafePrefix(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) {
    return content;
  }

  const lastIncludedCodeUnit = content.charCodeAt(maxCharacters - 1);
  const firstExcludedCodeUnit = content.charCodeAt(maxCharacters);
  const endsWithHighSurrogate =
    lastIncludedCodeUnit >= 0xd800 && lastIncludedCodeUnit <= 0xdbff;
  const startsWithLowSurrogate =
    firstExcludedCodeUnit >= 0xdc00 && firstExcludedCodeUnit <= 0xdfff;
  const end =
    endsWithHighSurrogate && startsWithLowSurrogate
      ? maxCharacters + 1
      : maxCharacters;
  return content.slice(0, end);
}

async function listFiles(
  rootDir: string,
  currentDir: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }

    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, entryPath)));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, entryPath));
    }
  }

  return files.sort(compareRawFilePaths);
}

function compareRawFilePaths(left: string, right: string): number {
  const [leftRun = "", leftFile = ""] = left.split("/", 2);
  const [rightRun = "", rightFile = ""] = right.split("/", 2);

  if (leftRun !== rightRun) {
    return rightRun.localeCompare(leftRun);
  }

  return leftFile.localeCompare(rightFile);
}

function getLatestRunId(files: string[]): string | null {
  const firstFile = files[0];
  if (!firstFile) {
    return null;
  }

  return firstFile.split("/", 1)[0] ?? null;
}

function getConnectorId(input: unknown, key: string): ConnectorId {
  const value = getStringInput(input, key);

  if (!isConnectorId(value)) {
    throw new Error(`Invalid connector ID: ${value}`);
  }

  return value;
}

function getIngestOptions(input: unknown): ConnectorIngestOptions {
  return {
    limit: getNumberInput(input, "limit") ?? undefined,
    streams: getStringArrayInput(input, "streams"),
    windowHours: getNumberInput(input, "windowHours") ?? undefined,
  };
}

function getStringInput(input: unknown, key: string): string {
  if (!isRecord(input) || typeof input[key] !== "string") {
    throw new Error(`Missing string input: ${key}`);
  }

  return input[key];
}

function getSourceUpdateOutcome(
  input: unknown,
  key: string,
): ConnectorSourceUpdateReceipt["outcome"] {
  const value = getStringInput(input, key);
  if (value !== "no_changes" && value !== "updated") {
    throw new Error(`Invalid source update outcome: ${value}`);
  }
  return value;
}

function getNumberInput(input: unknown, key: string): number | null {
  if (!isRecord(input) || input[key] === undefined) {
    return null;
  }

  if (typeof input[key] !== "number") {
    throw new Error(`Expected number input: ${key}`);
  }

  return input[key];
}

function getRecordInput(
  input: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(input) || input[key] === undefined) {
    return null;
  }

  if (!isRecord(input[key])) {
    throw new Error(`Expected object input: ${key}`);
  }

  return input[key];
}

function getStringArrayInput(
  input: unknown,
  key: string,
): string[] | undefined {
  if (!isRecord(input) || input[key] === undefined) {
    return undefined;
  }

  if (!Array.isArray(input[key])) {
    throw new Error(`Expected string array input: ${key}`);
  }

  return input[key].filter(
    (value): value is string => typeof value === "string",
  );
}

function stringifyToolResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function mergeReadRanges(ranges: ReadRange[]): ReadRange[] {
  const merged: ReadRange[] = [];
  for (const range of [...ranges].sort(
    (left, right) => left.start - right.start,
  )) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function coversWholeFile(
  ranges: ReadRange[],
  totalCharacters: number,
): boolean {
  if (totalCharacters === 0) {
    return ranges.some((range) => range.start === 0 && range.end === 0);
  }
  return (
    ranges.length === 1 &&
    ranges[0]?.start === 0 &&
    ranges[0].end >= totalCharacters
  );
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}
