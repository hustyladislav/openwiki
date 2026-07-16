import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("deterministic source update tools", () => {
  test("exposes only raw reading and completion and requires full-file coverage", async () => {
    const home = await mkdtemp(
      path.join(tmpdir(), "openwiki-source-tools-test-"),
    );
    tempHomes.push(home);
    process.env.HOME = home;
    vi.resetModules();

    const rawFile = path.join(
      home,
      ".openwiki/connectors/langsmith/raw/run-1/manifest.json",
    );
    await mkdir(path.dirname(rawFile), { recursive: true });
    await writeFile(rawFile, "0123456789", "utf8");

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    let receipt:
      | {
          connectorId: string;
          outcome: string;
          rawFilesRead: string[];
          summary: string;
        }
      | undefined;
    const tools = createOpenWikiConnectorTools({
      onSourceUpdateReceipt: (nextReceipt) => {
        receipt = nextReceipt;
      },
      sourceUpdate: {
        connectorId: "langsmith",
        rawFiles: [rawFile],
      },
    });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "openwiki_complete_source_update",
      "openwiki_read_raw_item",
    ]);

    const readTool = tools.find(
      (tool) => tool.name === "openwiki_read_raw_item",
    );
    const completeTool = tools.find(
      (tool) => tool.name === "openwiki_complete_source_update",
    );
    expect(readTool).toBeDefined();
    expect(completeTool).toBeDefined();
    if (!readTool || !completeTool) {
      throw new Error("Expected source update tools.");
    }

    const wrongConnector = JSON.parse(
      String(
        await readTool.invoke({
          connectorId: "notion",
          offsetCharacters: 0,
          path: "run-1/manifest.json",
        }),
      ),
    ) as { allowed: boolean; error: string; instruction: string };
    expect(wrongConnector.allowed).toBe(false);
    expect(wrongConnector.error).toContain("only read raw files for langsmith");
    expect(wrongConnector.instruction).toContain("No file was read");

    const unlistedFile = JSON.parse(
      String(
        await readTool.invoke({
          connectorId: "langsmith",
          offsetCharacters: 0,
          path: "run-1/unlisted.json",
        }),
      ),
    ) as { allowed: boolean; error: string; instruction: string };
    expect(unlistedFile.allowed).toBe(false);
    expect(unlistedFile.error).toContain("exact raw files declared");
    expect(unlistedFile.instruction).toContain("No file was read");

    const outsideRawDirectory = JSON.parse(
      String(
        await readTool.invoke({
          connectorId: "langsmith",
          offsetCharacters: 0,
          path: "../../outside.json",
        }),
      ),
    ) as { allowed: boolean; error: string; instruction: string };
    expect(outsideRawDirectory.allowed).toBe(false);
    expect(outsideRawDirectory.error).toContain("exact raw files declared");
    expect(outsideRawDirectory.instruction).toContain("No file was read");

    const initialCompletion = parseCompletionResult(
      await completeTool.invoke({
        outcome: "no_changes",
        summary: "No changes.",
      }),
    );
    expect(initialCompletion.completed).toBe(false);
    expect(initialCompletion.error).toContain("reading every raw file in full");

    const firstPage = JSON.parse(
      String(
        await readTool.invoke({
          connectorId: "langsmith",
          maxBytes: 4,
          offsetCharacters: 0,
          path: "run-1/manifest.json",
        }),
      ),
    ) as { nextOffsetCharacters: number };
    expect(firstPage.nextOffsetCharacters).toBe(4);
    await readTool.invoke({
      connectorId: "langsmith",
      maxBytes: 4,
      offsetCharacters: 4,
      path: "run-1/manifest.json",
    });

    const partialCompletion = parseCompletionResult(
      await completeTool.invoke({
        outcome: "no_changes",
        summary: "No changes.",
      }),
    );
    expect(partialCompletion.completed).toBe(false);
    expect(partialCompletion.error).toContain("reading every raw file in full");

    await readTool.invoke({
      connectorId: "langsmith",
      maxBytes: 4,
      offsetCharacters: 8,
      path: "run-1/manifest.json",
    });
    await completeTool.invoke({
      outcome: "no_changes",
      summary: "No durable knowledge was found.",
    });

    expect(receipt).toEqual({
      connectorId: "langsmith",
      outcome: "no_changes",
      rawFilesRead: ["run-1/manifest.json"],
      summary: "No durable knowledge was found.",
    });
  });

  test("keeps each encoded raw page below DeepAgents result eviction", async () => {
    const home = await mkdtemp(
      path.join(tmpdir(), "openwiki-source-tools-test-"),
    );
    tempHomes.push(home);
    process.env.HOME = home;
    vi.resetModules();

    const rawFile = path.join(
      home,
      ".openwiki/connectors/langsmith/raw/run-1/thread.json",
    );
    await mkdir(path.dirname(rawFile), { recursive: true });
    await writeFile(rawFile, "x".repeat(50_000), "utf8");

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const readTool = createOpenWikiConnectorTools().find(
      (tool) => tool.name === "openwiki_read_raw_item",
    );
    expect(readTool).toBeDefined();
    if (!readTool) {
      throw new Error("Expected raw read tool.");
    }

    const page = JSON.parse(
      String(
        await readTool.invoke({
          connectorId: "langsmith",
          maxBytes: 500_000,
          offsetCharacters: 0,
          path: "run-1/thread.json",
        }),
      ),
    ) as { content: string; nextOffsetCharacters: number };
    expect(page.content).toHaveLength(20_000);
    expect(page.nextOffsetCharacters).toBe(20_000);
  });

  test("reconstructs large Unicode files exactly using bounded reads", async () => {
    const home = await mkdtemp(
      path.join(tmpdir(), "openwiki-source-tools-test-"),
    );
    tempHomes.push(home);
    process.env.HOME = home;
    vi.resetModules();

    const rawFile = path.join(
      home,
      ".openwiki/connectors/langsmith/raw/run-1/thread.json",
    );
    const rawContent = "a🙂é漢".repeat(20_000);
    await mkdir(path.dirname(rawFile), { recursive: true });
    await writeFile(rawFile, rawContent, "utf8");

    const probeHandle = await open(rawFile, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as Pick<
      FileHandle,
      "read" | "readFile"
    >;
    await probeHandle.close();
    const readSpy = vi.spyOn(fileHandlePrototype, "read");
    const readFileSpy = vi.spyOn(fileHandlePrototype, "readFile");

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const tools = createOpenWikiConnectorTools({
      sourceUpdate: {
        connectorId: "langsmith",
        rawFiles: [rawFile],
      },
    });
    const readTool = tools.find(
      (tool) => tool.name === "openwiki_read_raw_item",
    );
    const completeTool = tools.find(
      (tool) => tool.name === "openwiki_complete_source_update",
    );
    expect(readTool).toBeDefined();
    expect(completeTool).toBeDefined();
    if (!readTool || !completeTool) {
      throw new Error("Expected source update tools.");
    }

    type RawPage = {
      content: string;
      nextOffsetCharacters: number | null;
      offsetCharacters: number;
      totalCharacters: number | null;
      truncated: boolean;
    };
    const pages: RawPage[] = [];
    let offsetCharacters = 0;
    do {
      const requestedOffset = offsetCharacters;
      const page = JSON.parse(
        String(
          await readTool.invoke({
            connectorId: "langsmith",
            maxBytes: 19_997,
            offsetCharacters,
            path: "run-1/thread.json",
          }),
        ),
      ) as RawPage;
      pages.push(page);
      expect(page.offsetCharacters).toBe(requestedOffset);
      offsetCharacters = page.nextOffsetCharacters ?? offsetCharacters;

      if (page.truncated) {
        expect(page.totalCharacters).toBeNull();
        const partialCompletion = parseCompletionResult(
          await completeTool.invoke({
            outcome: "no_changes",
            summary: "Not finished.",
          }),
        );
        expect(partialCompletion.completed).toBe(false);
        expect(partialCompletion.error).toContain(
          "reading every raw file in full",
        );
      }
    } while (pages.at(-1)?.truncated);

    expect(pages.map((page) => page.content).join("")).toBe(rawContent);
    expect(pages.at(-1)?.totalCharacters).toBe(rawContent.length);
    expect(pages.at(-1)?.nextOffsetCharacters).toBeNull();
    expect(
      pages.every(
        (page) =>
          !isHighSurrogate(page.content.charCodeAt(page.content.length - 1)) &&
          !isLowSurrogate(page.content.charCodeAt(0)),
      ),
    ).toBe(true);
    await expect(
      completeTool.invoke({
        outcome: "no_changes",
        summary: "All Unicode evidence was reviewed.",
      }),
    ).resolves.toBeDefined();

    const nonsequentialPage = JSON.parse(
      String(
        await readTool.invoke({
          connectorId: "langsmith",
          maxBytes: 11,
          offsetCharacters: 12_345,
          path: "run-1/thread.json",
        }),
      ),
    ) as RawPage;
    expect(nonsequentialPage.offsetCharacters).toBe(12_345);
    expect(nonsequentialPage.content).toBe(rawContent.slice(12_345, 12_356));
    expect(nonsequentialPage.totalCharacters).toBeNull();

    const repeatedFirstPage = JSON.parse(
      String(
        await readTool.invoke({
          connectorId: "langsmith",
          maxBytes: 19_997,
          offsetCharacters: 0,
          path: "run-1/thread.json",
        }),
      ),
    ) as RawPage;
    expect(repeatedFirstPage).toEqual(pages[0]);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalled();
    for (const call of readSpy.mock.calls) {
      expect(call[2]).toBeLessThanOrEqual(64 * 1024);
    }
  });

  test("rejects a nonsequential offset inside an astral character", async () => {
    const home = await mkdtemp(
      path.join(tmpdir(), "openwiki-source-tools-test-"),
    );
    tempHomes.push(home);
    process.env.HOME = home;
    vi.resetModules();

    const rawFile = path.join(
      home,
      ".openwiki/connectors/langsmith/raw/run-1/thread.json",
    );
    await mkdir(path.dirname(rawFile), { recursive: true });
    await writeFile(rawFile, "a🙂b", "utf8");

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const readTool = createOpenWikiConnectorTools().find(
      (tool) => tool.name === "openwiki_read_raw_item",
    );
    expect(readTool).toBeDefined();
    if (!readTool) {
      throw new Error("Expected raw read tool.");
    }

    await expect(
      readTool.invoke({
        connectorId: "langsmith",
        maxBytes: 1,
        offsetCharacters: 2,
        path: "run-1/thread.json",
      }),
    ).rejects.toThrow("splits a Unicode character");
  });
});

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function parseCompletionResult(value: unknown): {
  completed: boolean;
  error?: string;
} {
  return JSON.parse(String(value)) as {
    completed: boolean;
    error?: string;
  };
}
