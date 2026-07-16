import { describe, expect, test } from "vitest";
import {
  assertSynthesisCompleted,
  createSourceUpdateMessage,
} from "../src/ingestion.ts";
import type { ConnectorRuntime } from "../src/connectors/types.ts";

describe("deterministic ingestion prompt", () => {
  test("uses the manifest query window for historical LangSmith batches", () => {
    const connector: ConnectorRuntime = {
      backend: "direct-api",
      description: "LangSmith traces",
      displayName: "LangSmith",
      id: "langsmith",
      ingest: () => Promise.reject(new Error("not used")),
      requiredEnv: [],
      supportsAgenticDiscovery: false,
    };
    const message = createSourceUpdateMessage({
      config: { sourceInstances: [], sources: {}, version: 1 },
      connector,
      deterministicPull: {
        connectorId: "langsmith",
        message: "Pulled a historical batch.",
        queryWindow: {
          since: "2026-04-23T00:00:00.000Z",
          until: "2026-04-30T00:00:00.000Z",
        },
        rawFiles: ["/tmp/manifest.json"],
        runId: "run-1",
        statePath: "~/.openwiki/connectors/langsmith/state.json",
        status: "success",
        warnings: [],
      },
      rawFiles: ["/tmp/manifest.json"],
      sourceConfig: {
        connectedAt: "2026-07-16T00:00:00.000Z",
        connectorId: "langsmith",
        id: "langsmith-1",
      },
      window: {
        since: "2026-07-15T00:00:00.000Z",
        until: "2026-07-16T00:00:00.000Z",
        windowHours: 24,
      },
    });

    expect(message).toContain(
      "2026-04-23T00:00:00.000Z (inclusive) through 2026-04-30T00:00:00.000Z (exclusive)",
    );
    expect(message).toContain("Do not narrow it to a generic 24-hour window");
    expect(message).not.toContain("Use the last 24 hours");
    expect(message).toContain("openwiki_complete_source_update");
    expect(message).toContain("nextOffsetCharacters");
    expect(message).toContain("totalCharacters remains null until");
  });

  test("requires an explicit receipt while allowing a reviewed no-op", () => {
    expect(() =>
      assertSynthesisCompleted(
        { command: "update", model: "gpt-5.6-sol", wikiChanged: false },
        "langsmith",
      ),
    ).toThrow("completion receipt");

    expect(() =>
      assertSynthesisCompleted(
        {
          command: "update",
          model: "gpt-5.6-sol",
          sourceUpdateReceipt: {
            connectorId: "langsmith",
            outcome: "no_changes",
            rawFilesRead: ["run-1/manifest.json"],
            summary: "No durable knowledge was found.",
          },
          wikiChanged: false,
        },
        "langsmith",
      ),
    ).not.toThrow();

    expect(() =>
      assertSynthesisCompleted(
        {
          command: "update",
          model: "gpt-5.6-sol",
          sourceUpdateReceipt: {
            connectorId: "langsmith",
            outcome: "updated",
            rawFilesRead: ["run-1/manifest.json"],
            summary: "Updated durable memories.",
          },
          wikiChanged: false,
        },
        "langsmith",
      ),
    ).toThrow("produced no durable wiki change");
  });
});
