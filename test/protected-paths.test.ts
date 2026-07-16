import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isProtectedWikiPath,
  loadOpenWikiProtectedPaths,
  PROTECTED_PATHS_MANIFEST,
} from "../src/agent/protected-paths.ts";

const protectedPathValues = [
  PROTECTED_PATHS_MANIFEST,
  "automation/",
  "workflows/openwiki-refresh.md",
];

async function setup(outputMode: "local-wiki" | "repository" = "local-wiki") {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-protected-"));
  const wikiRoot =
    outputMode === "local-wiki" ? rootDir : path.join(rootDir, "openwiki");
  await mkdir(wikiRoot, { recursive: true });
  return { rootDir, wikiRoot };
}

async function writeManifest(
  wikiRoot: string,
  protectedPaths = protectedPathValues,
) {
  await writeFile(
    path.join(wikiRoot, PROTECTED_PATHS_MANIFEST),
    `${JSON.stringify({ schemaVersion: 1, protectedPaths }, null, 2)}\n`,
  );
}

describe("OpenWiki protected paths", () => {
  test("keeps the policy optional for upstream-compatible wikis", async () => {
    const { rootDir } = await setup();
    expect(loadOpenWikiProtectedPaths(rootDir, "local-wiki")).toEqual([]);
  });

  test.each(["local-wiki", "repository"] as const)(
    "loads and matches normalized %s virtual paths",
    async (outputMode) => {
      const { rootDir, wikiRoot } = await setup(outputMode);
      await writeManifest(wikiRoot);

      const policy = loadOpenWikiProtectedPaths(rootDir, outputMode);
      const prefix = outputMode === "repository" ? "/openwiki" : "";
      expect(
        isProtectedWikiPath(
          `${prefix}/automation/job.plist`,
          outputMode,
          policy,
        ),
      ).toBe(true);
      expect(
        isProtectedWikiPath(
          `${prefix}/Automation/JOB.plist`,
          outputMode,
          policy,
        ),
      ).toBe(true);
      if (outputMode === "repository") {
        expect(
          isProtectedWikiPath(
            "/OpenWiki/Automation/JOB.plist",
            outputMode,
            policy,
          ),
        ).toBe(true);
      }
      expect(
        isProtectedWikiPath(
          `${prefix}/projects/../automation/job.plist`,
          outputMode,
          policy,
        ),
      ).toBe(true);
      expect(
        isProtectedWikiPath(
          `${prefix}/workflows/openwiki-refresh.md`,
          outputMode,
          policy,
        ),
      ).toBe(true);
      expect(
        isProtectedWikiPath(`${prefix}/projects/memory.md`, outputMode, policy),
      ).toBe(false);
    },
  );

  test.each([
    {
      manifest: {
        schemaVersion: 1,
        protectedPaths: [PROTECTED_PATHS_MANIFEST, "../escape"],
      },
      message: "not a normalized repository path",
    },
    {
      manifest: {
        schemaVersion: 1,
        protectedPaths: ["automation/", PROTECTED_PATHS_MANIFEST],
      },
      message: "paths must be sorted",
    },
    {
      manifest: { schemaVersion: 1, protectedPaths: ["automation/"] },
      message: "must protect its own repository path",
    },
    {
      manifest: {
        schemaVersion: 2,
        protectedPaths: [PROTECTED_PATHS_MANIFEST],
      },
      message: "schemaVersion must be 1",
    },
  ])(
    "fails closed for an invalid present manifest",
    async ({ manifest, message }) => {
      const { rootDir, wikiRoot } = await setup();
      await writeFile(
        path.join(wikiRoot, PROTECTED_PATHS_MANIFEST),
        JSON.stringify(manifest),
      );
      expect(() => loadOpenWikiProtectedPaths(rootDir, "local-wiki")).toThrow(
        message,
      );
    },
  );

  test("rejects a symlinked manifest", async () => {
    const { rootDir, wikiRoot } = await setup();
    const target = path.join(rootDir, "policy.json");
    await writeFile(
      target,
      JSON.stringify({ schemaVersion: 1, protectedPaths: protectedPathValues }),
    );
    await symlink(target, path.join(wikiRoot, PROTECTED_PATHS_MANIFEST));
    expect(() => loadOpenWikiProtectedPaths(rootDir, "local-wiki")).toThrow(
      "must be a regular file",
    );
  });
});
