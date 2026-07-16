import { afterEach, describe, expect, test } from "vitest";
import {
  LANGSMITH_API_KEY_ENV_KEY,
  LANGSMITH_TRACING_API_KEY_ENV_KEY,
} from "../src/constants.ts";
import {
  getStaticSourceConfig,
  needsCredentialSetup,
} from "../src/credentials.tsx";

const ENV_KEYS = [
  "LANGSMITH_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENWIKI_MODEL_ID",
  "OPENWIKI_LANGSMITH_ENDPOINT",
  "OPENWIKI_PROVIDER",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const originalValue = originalEnv.get(key);

    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe("needsCredentialSetup", () => {
  test("requires provider setup for an invalid configured provider", () => {
    process.env.OPENWIKI_PROVIDER = "bogus";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-placeholder";
    process.env.OPENWIKI_MODEL_ID = "z-ai/glm-5.2";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";

    expect(needsCredentialSetup()).toBe(true);
  });
});

describe("LangSmith source configuration", () => {
  test("keeps connector ingestion separate from OpenWiki tracing", () => {
    expect(LANGSMITH_API_KEY_ENV_KEY).toBe("OPENWIKI_LANGSMITH_API_KEY");
    expect(LANGSMITH_TRACING_API_KEY_ENV_KEY).toBe("LANGSMITH_API_KEY");
  });

  test("uses the US endpoint by default", () => {
    expect(getStaticSourceConfig("langsmith", "my-agent-project", {})).toEqual({
      apiUrl: "https://api.smith.langchain.com",
      enabled: true,
      projectName: "my-agent-project",
    });
  });

  test("persists the configured EU endpoint in the source config", () => {
    expect(
      getStaticSourceConfig("langsmith", "my-agent-project", {
        OPENWIKI_LANGSMITH_ENDPOINT: "https://eu.api.smith.langchain.com",
      }),
    ).toEqual({
      apiUrl: "https://eu.api.smith.langchain.com",
      enabled: true,
      projectName: "my-agent-project",
    });
  });

  test("rejects endpoints outside the LangSmith US and EU allowlist", () => {
    expect(() =>
      getStaticSourceConfig("langsmith", "my-agent-project", {
        OPENWIKI_LANGSMITH_ENDPOINT: "https://example.com",
      }),
    ).toThrow(/LangSmith endpoint must be/u);
  });
});
