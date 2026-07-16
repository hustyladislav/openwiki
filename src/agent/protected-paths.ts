import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { OpenWikiOutputMode } from "./types.js";

export const PROTECTED_PATHS_MANIFEST = ".openwiki-protected-paths.json";

export interface OpenWikiProtectedPath {
  directory: boolean;
  path: string;
}

/** Loads an optional, repository-owned immutable-path policy once per run. */
export function loadOpenWikiProtectedPaths(
  rootDir: string,
  outputMode: OpenWikiOutputMode,
): OpenWikiProtectedPath[] {
  const wikiRoot =
    outputMode === "local-wiki" ? rootDir : path.join(rootDir, "openwiki");
  const manifestPath = path.join(wikiRoot, PROTECTED_PATHS_MANIFEST);
  if (!existsSync(manifestPath)) return [];

  const stat = lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      "OpenWiki protected-path manifest must be a regular file in the wiki root.",
    );
  }
  if (path.dirname(realpathSync(manifestPath)) !== realpathSync(wikiRoot)) {
    throw new Error(
      "OpenWiki protected-path manifest must resolve inside the wiki root.",
    );
  }

  const contents = readFileSync(manifestPath);
  if (contents.includes(0)) {
    throw new Error("OpenWiki protected-path manifest contains a NUL byte.");
  }

  let manifestText: string;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error("OpenWiki protected-path manifest is not valid UTF-8.");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch (error) {
    throw new Error(
      `OpenWiki protected-path manifest is not valid JSON: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!isRecord(manifest)) {
    throw new Error("OpenWiki protected-path manifest must be a JSON object.");
  }
  const keys = Object.keys(manifest).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "protectedPaths" ||
    keys[1] !== "schemaVersion"
  ) {
    throw new Error(
      "OpenWiki protected-path manifest must contain only schemaVersion and protectedPaths.",
    );
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      "OpenWiki protected-path manifest schemaVersion must be 1.",
    );
  }
  if (
    !Array.isArray(manifest.protectedPaths) ||
    manifest.protectedPaths.length === 0
  ) {
    throw new Error(
      "OpenWiki protected-path manifest protectedPaths must be a non-empty array.",
    );
  }

  const protectedPaths = manifest.protectedPaths.map(validateProtectedPath);
  const values = protectedPaths.map(formatProtectedPath);
  if (new Set(values).size !== values.length) {
    throw new Error(
      "OpenWiki protected-path manifest contains duplicate paths.",
    );
  }
  if (values.join("\0") !== [...values].sort().join("\0")) {
    throw new Error("OpenWiki protected-path manifest paths must be sorted.");
  }
  if (!values.includes(PROTECTED_PATHS_MANIFEST)) {
    throw new Error(
      "OpenWiki protected-path manifest must protect its own repository path.",
    );
  }
  return protectedPaths;
}

/** Returns whether a virtual wiki path is covered by an immutable-path rule. */
export function isProtectedWikiPath(
  filePath: string,
  outputMode: OpenWikiOutputMode,
  protectedPaths: readonly OpenWikiProtectedPath[],
): boolean {
  const relativePath = toWikiRelativePath(filePath, outputMode);
  if (relativePath === null) return false;
  const comparisonPath = relativePath.toLowerCase();

  return protectedPaths.some((protectedPath) =>
    protectedPath.directory
      ? comparisonPath === protectedPath.path.toLowerCase() ||
        comparisonPath.startsWith(`${protectedPath.path.toLowerCase()}/`)
      : comparisonPath === protectedPath.path.toLowerCase(),
  );
}

function validateProtectedPath(
  value: unknown,
  index: number,
): OpenWikiProtectedPath {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(
      `OpenWiki protected-path manifest entry ${index} must be a non-empty trimmed string.`,
    );
  }
  if (path.isAbsolute(value) || value.includes("\\") || value.includes("//")) {
    throw new Error(
      `OpenWiki protected-path manifest entry ${index} is not a safe repository path.`,
    );
  }

  const directory = value.endsWith("/");
  const normalizedPath = directory ? value.slice(0, -1) : value;
  const segments = normalizedPath.split("/");
  if (
    !normalizedPath ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      `OpenWiki protected-path manifest entry ${index} is not a normalized repository path.`,
    );
  }
  return { directory, path: normalizedPath };
}

function formatProtectedPath(protectedPath: OpenWikiProtectedPath): string {
  return `${protectedPath.path}${protectedPath.directory ? "/" : ""}`;
}

function toWikiRelativePath(
  filePath: string,
  outputMode: OpenWikiOutputMode,
): string | null {
  const normalizedPath = path.posix
    .normalize(`/${filePath.trim().replaceAll("\\", "/").replace(/^\/+/, "")}`)
    .replace(/^\/+/, "");
  if (outputMode === "local-wiki") return normalizedPath;
  const comparisonPath = normalizedPath.toLowerCase();
  if (comparisonPath === "openwiki") return "";
  return comparisonPath.startsWith("openwiki/")
    ? normalizedPath.slice("openwiki/".length)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
