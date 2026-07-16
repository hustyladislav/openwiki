import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FilesystemBackend } from "deepagents";
import { afterEach, describe, expect, test } from "vitest";
import { synchronizeWikiIndexes } from "../src/agent/index-middleware.ts";
import { createSystemPrompt } from "../src/agent/prompt.ts";
import {
  createOpenWikiCompositeBackend,
  OpenWikiCompositeBackend,
} from "../src/agent/virtual-runtime-backends.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("OpenWiki virtual runtime backends", () => {
  test("hides runtime routes from broad wiki discovery but keeps skills readable", async () => {
    const { backend } = await createBackend();

    const rootListing = await backend.ls("/");
    expect(rootListing.error).toBeUndefined();
    expect(rootListing.files?.map((file) => file.path)).toEqual([
      "/quickstart.md",
    ]);

    const broadGlob = await backend.glob("**/*.md", "/");
    expect(broadGlob.files?.map((file) => file.path)).toEqual([
      "/quickstart.md",
    ]);

    const broadGrep = await backend.grep("OpenWiki", "/");
    expect(broadGrep.matches?.map((match) => match.path)).toEqual([
      "/quickstart.md",
    ]);

    const skillsListing = await backend.ls("/skills/");
    expect(skillsListing.files?.map((file) => file.path)).toEqual([
      "/skills/example/",
    ]);
    await expect(
      backend.read("/skills/example/SKILL.md"),
    ).resolves.toMatchObject({ content: "# Example\n" });
    await expect(backend.glob("**/*.md", "/skills/")).resolves.toMatchObject({
      files: [expect.objectContaining({ path: "/skills/example/SKILL.md" })],
    });
    await expect(backend.grep("Example", "/skills/")).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "/skills/example/SKILL.md" })],
    });
  });

  test("returns recoverable errors for every skill mutation", async () => {
    const { backend, skillPath } = await createBackend();

    await expect(
      backend.write("/skills/example/SKILL.md", "changed"),
    ).resolves.toMatchObject({
      error: "OpenWiki bundled skills are read-only.",
    });
    await expect(
      backend.edit("/skills/example/SKILL.md", "Example", "Changed"),
    ).resolves.toMatchObject({
      error: "OpenWiki bundled skills are read-only.",
    });
    await expect(
      backend.delete("/skills/example/SKILL.md"),
    ).resolves.toMatchObject({
      error: "OpenWiki bundled skills are read-only.",
    });
    await expect(
      backend.uploadFiles([
        ["/skills/example/SKILL.md", new TextEncoder().encode("changed")],
      ]),
    ).resolves.toEqual([
      {
        error: "permission_denied",
        path: "/skills/example/SKILL.md",
      },
    ]);
    await expect(readFile(skillPath, "utf8")).resolves.toBe("# Example\n");

    await expect(
      backend.write("/memory.md", "# Memory\n"),
    ).resolves.toMatchObject({ path: "/memory.md" });
  });

  test("keeps runtime routes out of deterministic wiki indexes", async () => {
    const { backend, wikiRoot } = await createBackend();

    await synchronizeWikiIndexes(backend, "local-wiki");

    const index = await readFile(path.join(wikiRoot, "index.md"), "utf8");
    expect(index).toContain("[quickstart](quickstart.md)");
    expect(index).not.toContain("conversation_history");
    expect(index).not.toContain("large_tool_results");
    expect(index).not.toContain("[skills](skills/)");
    for (const runtimeDirectory of [
      "conversation_history",
      "large_tool_results",
      "skills",
    ]) {
      await expect(
        readFile(path.join(wikiRoot, runtimeDirectory, "index.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("labels runtime routes as non-wiki infrastructure", async () => {
    const systemPrompt = createSystemPrompt("update", "local-wiki");
    const migrationSkill = await readFile(
      path.resolve(
        import.meta.dirname,
        "../skills/migrate-wiki-to-okf/SKILL.md",
      ),
      "utf8",
    );

    for (const runtimePath of [
      "/skills",
      "/conversation_history",
      "/large_tool_results",
    ]) {
      expect(systemPrompt).toContain(runtimePath);
      expect(migrationSkill).toContain(runtimePath);
    }
    expect(systemPrompt).toContain("not wiki directories");
    expect(migrationSkill).toContain("not wiki directories");
  });
});

async function createBackend(): Promise<{
  backend: OpenWikiCompositeBackend;
  skillPath: string;
  wikiRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-runtime-"));
  temporaryRoots.push(root);
  const wikiRoot = path.join(root, "wiki");
  const skillsRoot = path.join(root, "skills");
  const skillDirectory = path.join(skillsRoot, "example");
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await mkdir(wikiRoot);
  await mkdir(skillDirectory, { recursive: true });
  for (const runtimeDirectory of [
    "conversation_history",
    "large_tool_results",
    "skills",
  ]) {
    const physicalRuntimeDirectory = path.join(wikiRoot, runtimeDirectory);
    await mkdir(physicalRuntimeDirectory);
    await writeFile(
      path.join(physicalRuntimeDirectory, "runtime.md"),
      "# OpenWiki runtime data\n",
    );
  }
  await writeFile(path.join(wikiRoot, "quickstart.md"), "# OpenWiki\n");
  await writeFile(skillPath, "# Example\n");

  const backend = createOpenWikiCompositeBackend(
    new FilesystemBackend({ rootDir: wikiRoot, virtualMode: true }),
    skillsRoot,
  );
  return { backend, skillPath, wikiRoot };
}
