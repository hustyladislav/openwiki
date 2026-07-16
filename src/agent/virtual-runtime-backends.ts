import {
  CompositeBackend,
  type AnyBackendProtocol,
  type BackendProtocolV2,
  type DeleteResult,
  type EditResult,
  type FileUploadResponse,
  FilesystemBackend,
  type GlobResult,
  type GrepResult,
  type LsResult,
  StateBackend,
  type WriteResult,
} from "deepagents";

const RUNTIME_ONLY_ROOT_PATHS = [
  "/conversation_history/",
  "/large_tool_results/",
  "/skills/",
] as const;
const READ_ONLY_SKILLS_ERROR = "OpenWiki bundled skills are read-only.";

export function createOpenWikiCompositeBackend(
  wikiBackend: BackendProtocolV2,
  skillsRoot: string,
): OpenWikiCompositeBackend {
  return new OpenWikiCompositeBackend(wikiBackend, {
    "/conversation_history/": new StateBackend(),
    "/large_tool_results/": new StateBackend(),
    "/skills/": new ReadOnlyFilesystemBackend({
      rootDir: skillsRoot,
      virtualMode: true,
    }),
  });
}

export class OpenWikiCompositeBackend extends CompositeBackend {
  private readonly wikiBackend: BackendProtocolV2;

  constructor(
    defaultBackend: BackendProtocolV2,
    routes: Record<string, AnyBackendProtocol>,
  ) {
    super(defaultBackend, routes);
    this.wikiBackend = defaultBackend;
  }

  override async ls(directoryPath: string): Promise<LsResult> {
    if (!isVirtualRoot(directoryPath)) return await super.ls(directoryPath);
    const result = await this.wikiBackend.ls(directoryPath);
    if (!result.files) return result;

    return {
      ...result,
      files: result.files.filter((file) => !isRuntimeOnlyPath(file.path)),
    };
  }

  override async glob(
    pattern: string,
    searchPath?: string,
  ): Promise<GlobResult> {
    if (!isBroadWikiSearch(searchPath)) {
      return await super.glob(pattern, searchPath);
    }
    const result = await this.wikiBackend.glob(pattern, searchPath);
    if (!result.files) return result;

    return {
      ...result,
      files: result.files.filter((file) => !isRuntimeOnlyPath(file.path)),
    };
  }

  override async grep(
    pattern: string,
    searchPath?: string | null,
    glob?: string | null,
  ): Promise<GrepResult> {
    if (!isBroadWikiSearch(searchPath)) {
      return await super.grep(pattern, searchPath, glob);
    }
    const result = await this.wikiBackend.grep(pattern, searchPath, glob);
    if (!result.matches) return result;

    return {
      ...result,
      matches: result.matches.filter((match) => !isRuntimeOnlyPath(match.path)),
    };
  }
}

export class ReadOnlyFilesystemBackend extends FilesystemBackend {
  override write(): Promise<WriteResult> {
    return Promise.resolve({ error: READ_ONLY_SKILLS_ERROR });
  }

  override edit(): Promise<EditResult> {
    return Promise.resolve({ error: READ_ONLY_SKILLS_ERROR });
  }

  override delete(): Promise<DeleteResult> {
    return Promise.resolve({ error: READ_ONLY_SKILLS_ERROR });
  }

  override uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    return Promise.resolve(
      files.map(([filePath]) => ({
        error: "permission_denied",
        path: filePath,
      })),
    );
  }
}

function isBroadWikiSearch(searchPath: string | null | undefined): boolean {
  return (
    searchPath === undefined || searchPath === null || isVirtualRoot(searchPath)
  );
}

function isRuntimeOnlyPath(filePath: string): boolean {
  const normalizedPath = normalizeVirtualPath(filePath);
  return RUNTIME_ONLY_ROOT_PATHS.some((runtimePath) => {
    const normalizedRuntimePath = normalizeVirtualPath(runtimePath);
    return (
      normalizedPath === normalizedRuntimePath ||
      normalizedPath.startsWith(`${normalizedRuntimePath}/`)
    );
  });
}

function isVirtualRoot(filePath: string): boolean {
  const normalizedPath = normalizeVirtualPath(filePath);
  return normalizedPath === "" || normalizedPath === ".";
}

function normalizeVirtualPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/+|\/+$/gu, "");
}
