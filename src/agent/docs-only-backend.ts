import {
  LocalShellBackend,
  type EditResult,
  type ExecuteResponse,
  type FileUploadResponse,
  type LocalShellBackendOptions,
  type WriteResult,
} from "deepagents";
import { OPEN_WIKI_DIR } from "../constants.js";
import type { OpenWikiOutputMode } from "./types.js";

export const MUTATION_PATH_METADATA_KEY = "openwikiMutationPath";

type OpenWikiBackendOptions = LocalShellBackendOptions & {
  docsOnly?: boolean;
  outputMode?: OpenWikiOutputMode;
  readOnly?: boolean;
  shellDisabled?: boolean;
};

export class OpenWikiLocalShellBackend extends LocalShellBackend {
  private readonly docsOnly: boolean;
  private readonly outputMode: OpenWikiOutputMode;
  private readonly readOnly: boolean;
  private readonly shellDisabled: boolean;

  constructor(options: OpenWikiBackendOptions) {
    super(options);
    this.docsOnly = options.docsOnly === true;
    this.outputMode = options.outputMode ?? "repository";
    this.readOnly = options.readOnly === true;
    this.shellDisabled = this.readOnly || options.shellDisabled === true;
  }

  override async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    if (this.readOnly) {
      return files.map(([filePath]) => ({
        error: "permission_denied",
        path: filePath,
      }));
    }

    if (!this.shellDisabled) {
      return await super.uploadFiles(files);
    }

    const responses: FileUploadResponse[] = [];
    for (const file of files) {
      if (isTransientAgentPath(file[0])) {
        responses.push({ error: "permission_denied", path: file[0] });
      } else {
        responses.push(...(await super.uploadFiles([file])));
      }
    }
    return responses;
  }

  override async execute(command: string): Promise<ExecuteResponse> {
    if (this.shellDisabled) {
      return {
        output: "OpenWiki shell execution is disabled for this run.",
        exitCode: 1,
        truncated: false,
      };
    }

    return await super.execute(command);
  }

  override async write(
    filePath: string,
    content: string,
  ): Promise<WriteResult> {
    const error = this.getDocsOnlyWriteError(filePath);
    if (error) {
      return { error };
    }

    return markMutation(await super.write(filePath, content), filePath);
  }

  override async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const error = this.getDocsOnlyWriteError(filePath);
    if (error) {
      return { error };
    }

    return markMutation(
      await super.edit(filePath, oldString, newString, replaceAll),
      filePath,
    );
  }

  private getDocsOnlyWriteError(filePath: string): string | null {
    if (this.readOnly) {
      return "OpenWiki query mode is read-only; file writes are disabled.";
    }

    if (this.shellDisabled && isTransientAgentPath(filePath)) {
      return "OpenWiki transient agent files must use ephemeral agent state.";
    }

    if (
      !this.docsOnly ||
      this.outputMode === "local-wiki" ||
      isOpenWikiDocsPath(filePath)
    ) {
      return null;
    }

    return `OpenWiki repository init/update runs may only write under /${OPEN_WIKI_DIR}/. Refused path: ${filePath}`;
  }
}

function isTransientAgentPath(filePath: string): boolean {
  const normalizedPath = filePath
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/+|\/+$/gu, "");
  return (
    normalizedPath === "conversation_history" ||
    normalizedPath.startsWith("conversation_history/") ||
    normalizedPath === "large_tool_results" ||
    normalizedPath.startsWith("large_tool_results/")
  );
}

/** Carries a successful mutation's file path into the ToolMessage metadata used by the validator. */
function markMutation<Result extends WriteResult | EditResult>(
  result: Result,
  filePath: string,
): Result {
  if (!result.error) {
    result.metadata = {
      ...result.metadata,
      [MUTATION_PATH_METADATA_KEY]: result.path ?? filePath,
    };
  }
  return result;
}

export function isOpenWikiDocsPath(filePath: string): boolean {
  const normalizedPath = filePath.trim().replace(/\\/gu, "/");
  const virtualPath = normalizedPath.replace(/^\/+/u, "");

  return (
    virtualPath === OPEN_WIKI_DIR || virtualPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}
