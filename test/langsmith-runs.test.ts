import { describe, expect, test } from "vitest";
import {
  compactLangSmithRuns,
  createThreadFileIdentifier,
  sanitizePathSegment,
} from "../src/connectors/sources/langsmith/runs.ts";
import type { LangSmithRunRecord } from "../src/connectors/sources/langsmith/types.ts";

describe("LangSmith run compaction", () => {
  test("retains only user and assistant text with provenance", () => {
    const run = createRun({
      inputs: {
        messages: [
          { content: "private system prompt", role: "system" },
          {
            content: [
              { text: "remember this decision", type: "text" },
              { data: "image bytes", type: "image" },
            ],
            role: "human",
          },
          { content: "tool request", role: "tool" },
        ],
      },
      outputs: {
        messages: [
          {
            content: [
              { text: "durable response", type: "output_text" },
              { thinking: "hidden reasoning", type: "reasoning" },
            ],
            role: "ai",
          },
          { content: "tool result", role: "tool" },
        ],
      },
    });

    const result = compactLangSmithRuns(
      [run],
      { id: null, name: "example-project" },
      "https://eu.api.smith.langchain.com",
    );
    const turn = result.threads[0]?.turns[0];

    expect(turn?.user).toEqual(["remember this decision"]);
    expect(turn?.assistant).toEqual(["durable response"]);
    expect(turn?.traceUrl).toBe(
      "https://eu.smith.langchain.com/o/test/projects/p/test/r/run-1",
    );
    expect(JSON.stringify(turn)).not.toContain("system prompt");
    expect(JSON.stringify(turn)).not.toContain("tool result");
    expect(JSON.stringify(turn)).not.toContain("hidden reasoning");
  });

  test("merges user and assistant messages found across inputs and outputs", () => {
    const run = createRun({
      inputs: {
        messages: [
          { content: "input user", role: "user" },
          { content: "input assistant", role: "assistant" },
        ],
      },
      outputs: {
        messages: [
          { content: "output user", role: "user" },
          { content: "output assistant", role: "assistant" },
        ],
      },
    });

    const turn = compactLangSmithRuns(
      [run],
      { id: null, name: "example-project" },
      "https://api.smith.langchain.com",
    ).threads[0]?.turns[0];

    expect(turn?.user).toEqual(["input user", "output user"]);
    expect(turn?.assistant).toEqual(["input assistant", "output assistant"]);
  });

  test("retains output-only raw agent messages as assistant evidence", () => {
    const run = createRun({
      outputs: {
        messages: [
          {
            _raw: {
              author: "/root/reviewer",
              content: [
                { text: "subagent finding", type: "input_text" },
                { encrypted_content: "opaque", type: "encrypted_content" },
              ],
              type: "agent_message",
            },
            role: "unknown",
          },
        ],
      },
    });

    const turn = compactLangSmithRuns(
      [run],
      { id: null, name: "example-project" },
      "https://api.smith.langchain.com",
    ).threads[0]?.turns[0];

    expect(turn?.assistant).toEqual(["subagent finding"]);
    expect(JSON.stringify(turn)).not.toContain("opaque");
  });

  test("drops trace URL parameters and invalid app paths", () => {
    const withSecretQuery = createRun({
      appPath: "/o/test/projects/p/test/r/run-1?token=secret#fragment",
    });
    const invalid = createRun({ appPath: "https://attacker.example/run" });

    const safeTurn = compactLangSmithRuns(
      [withSecretQuery],
      { id: null, name: "agent-project" },
      "https://api.smith.langchain.com",
    ).threads[0]?.turns[0];
    const invalidTurn = compactLangSmithRuns(
      [invalid],
      { id: null, name: "agent-project" },
      "https://api.smith.langchain.com",
    ).threads[0]?.turns[0];

    expect(safeTurn?.traceUrl).toBe(
      "https://smith.langchain.com/o/test/projects/p/test/r/run-1",
    );
    expect(invalidTurn?.traceUrl).toBeNull();
  });

  test("deduplicates aliases by logical turn and preserves duplicate IDs", () => {
    const first = createRun({ id: "run-a", traceId: "trace-a" });
    const duplicate = createRun({
      id: "run-b",
      startTime: "2026-07-15T00:00:01.000Z",
      traceId: "trace-b",
    });
    const result = compactLangSmithRuns(
      [duplicate, first],
      { id: null, name: "example-project" },
      "https://api.smith.langchain.com",
    );

    expect(result.logicalTurns).toBe(1);
    expect(result.duplicateRuns).toBe(1);
    expect(result.threads[0]?.turns[0]).toMatchObject({
      duplicateRunIds: ["run-b"],
      runId: "run-a",
    });
  });

  test("merges complementary alias text while retaining canonical provenance", () => {
    const first = createRun({
      endTime: "2026-07-15T00:01:00.000Z",
      id: "run-a",
      inputs: {
        messages: [{ content: "first user detail", role: "user" }],
      },
      name: "older-alias",
      outputs: {
        messages: [{ content: "first assistant detail", role: "assistant" }],
      },
    });
    const canonical = createRun({
      endTime: "2026-07-15T00:02:00.000Z",
      id: "run-b",
      inputs: {
        messages: [{ content: "second user detail", role: "user" }],
      },
      name: "canonical-alias",
      outputs: {
        messages: [{ content: "second assistant detail", role: "assistant" }],
      },
      startTime: "2026-07-15T00:00:01.000Z",
    });
    const result = compactLangSmithRuns(
      [canonical, first],
      { id: null, name: "example-project" },
      "https://api.smith.langchain.com",
    );

    expect(result.threads[0]?.turns[0]).toMatchObject({
      assistant: ["first assistant detail", "second assistant detail"],
      duplicateRunIds: ["run-a"],
      runId: "run-b",
      runName: "canonical-alias",
      user: ["first user detail", "second user detail"],
    });
  });

  test("does not deduplicate matching turn IDs across different threads", () => {
    const first = createRun({ id: "run-a", threadId: "thread-a" });
    const second = createRun({ id: "run-b", threadId: "thread-b" });
    const result = compactLangSmithRuns(
      [first, second],
      { id: null, name: "example-project" },
      "https://api.smith.langchain.com",
    );

    expect(result.logicalTurns).toBe(2);
    expect(result.duplicateRuns).toBe(0);
    expect(result.threads.map((thread) => thread.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
  });

  test("redacts secrets from every retained LangSmith string field", () => {
    const environmentSecret = "exact-environment-secret-123";
    const githubToken = ["ghp", "_1234567890abcdefghijklmnopqrstuvwxyzAB"].join(
      "",
    );
    const githubFineGrainedToken = [
      "github",
      "_pat_11ABCDEFG_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("");
    const previousPassword = process.env.OPENWIKI_TEST_PASSWORD;
    process.env.OPENWIKI_TEST_PASSWORD = environmentSecret;
    try {
      const canonical = createRun({
        error: `error ${githubToken}`,
        id: environmentSecret,
        inputs: {
          messages: [
            {
              content: `user ${environmentSecret} ${githubToken}`,
              role: "user",
            },
          ],
        },
        name: `name ${githubFineGrainedToken}`,
        outputs: {
          messages: [
            {
              content: `assistant ${githubFineGrainedToken}`,
              role: "assistant",
            },
          ],
        },
        runType: `type ${githubToken}`,
        status: `status ${environmentSecret}`,
        traceId: `trace ${githubToken}`,
      });
      canonical.app_path = `/o/${githubFineGrainedToken}/projects/p/test/r/${environmentSecret}`;
      canonical.extra = {
        metadata: {
          agent_name: `agent ${githubToken}`,
          cwd: `/private/${environmentSecret}`,
          model: `model ${githubFineGrainedToken}`,
          thread_id: `thread ${environmentSecret}`,
          turn_id: `turn ${githubToken}`,
          turn_number: 1,
        },
      };

      const duplicate = createRun({
        id: githubToken,
        outputs: { messages: [] },
      });
      duplicate.extra = canonical.extra;

      const result = compactLangSmithRuns(
        [duplicate, canonical],
        {
          id: `project ${githubFineGrainedToken}`,
          name: `project ${environmentSecret}`,
        },
        "https://api.smith.langchain.com",
      );
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain(environmentSecret);
      expect(serialized).not.toContain(githubToken);
      expect(serialized).not.toContain(githubFineGrainedToken);
      expect(serialized).toContain("REDACTED");
      expect(result.threads[0]?.turns[0]).toMatchObject({
        duplicateRunIds: ["[REDACTED:GITHUB_TOKEN]"],
        runId: "[REDACTED:OPENWIKI_TEST_PASSWORD]",
      });
    } finally {
      if (previousPassword === undefined) {
        delete process.env.OPENWIKI_TEST_PASSWORD;
      } else {
        process.env.OPENWIKI_TEST_PASSWORD = previousPassword;
      }
    }
  });

  test("redacts common historical credential shapes", () => {
    const slackToken = [
      "xoxb",
      "-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
    ].join("");
    const googleApiKey = ["AIza", "SyDUMMYEXAMPLE1234567890abcdefghijk"].join(
      "",
    );
    const awsAccessKeyId = ["AKIA", "1234567890ABCDEF"].join("");
    const privateKey = [
      ["-----BEGIN", " PRIVATE KEY-----"].join(""),
      "c2VjcmV0LWtleS1tYXRlcmlhbA==",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const run = createRun({
      inputs: {
        messages: [
          {
            content: [
              slackToken,
              googleApiKey,
              awsAccessKeyId,
              privateKey,
            ].join("\n"),
            role: "user",
          },
        ],
      },
    });

    const serialized = JSON.stringify(
      compactLangSmithRuns(
        [run],
        { id: null, name: "example-project" },
        "https://api.smith.langchain.com",
      ),
    );

    expect(serialized).not.toContain(slackToken);
    expect(serialized).not.toContain(googleApiKey);
    expect(serialized).not.toContain(awsAccessKeyId);
    expect(serialized).not.toContain("c2VjcmV0LWtleS1tYXRlcmlhbA");
    expect(serialized).toContain("[REDACTED:SLACK_TOKEN]");
    expect(serialized).toContain("[REDACTED:GOOGLE_API_KEY]");
    expect(serialized).toContain("[REDACTED:AWS_ACCESS_KEY_ID]");
    expect(serialized).toContain("[REDACTED:PRIVATE_KEY]");
  });

  test("redacts common connector tokens and context-labeled AWS secrets", () => {
    const notionToken = `secret_${"n".repeat(32)}`;
    const linearApiKey = `lin_api_${"l".repeat(32)}`;
    const awsSecretAccessKey = "aB9/+".repeat(8);
    const unlabeledAwsLikeValue = "Z".repeat(40);
    const run = createRun({
      inputs: {
        messages: [
          {
            content: [
              notionToken,
              linearApiKey,
              `AWS_SECRET_ACCESS_KEY=${awsSecretAccessKey}`,
              `"SecretAccessKey": "${awsSecretAccessKey}"`,
              `checksum=${unlabeledAwsLikeValue}`,
            ].join("\n"),
            role: "user",
          },
        ],
      },
    });

    const serialized = JSON.stringify(
      compactLangSmithRuns(
        [run],
        { id: null, name: "example-project" },
        "https://api.smith.langchain.com",
      ),
    );

    expect(serialized).not.toContain(notionToken);
    expect(serialized).not.toContain(linearApiKey);
    expect(serialized).not.toContain(awsSecretAccessKey);
    expect(serialized).toContain("[REDACTED:NOTION_TOKEN]");
    expect(serialized).toContain("[REDACTED:LINEAR_API_KEY]");
    expect(serialized).toContain("[REDACTED:AWS_SECRET_ACCESS_KEY]");
    expect(serialized).toContain(unlabeledAwsLikeValue);
  });

  test("redacts passwords in supported connection URIs", () => {
    const connectionUris = [
      "postgres://reader:postgres-password@db.example/prod",
      "postgresql://reader:postgresql-password@db.example/prod",
      "mysql://reader:mysql-password@db.example/prod",
      "redis://reader:redis-password@cache.example/0",
      "http://reader:http-password@example.com/private",
      "https://reader:https-password@example.com/private",
    ];
    const run = createRun({
      inputs: {
        messages: [{ content: connectionUris.join("\n"), role: "user" }],
      },
    });

    const serialized = JSON.stringify(
      compactLangSmithRuns(
        [run],
        { id: null, name: "example-project" },
        "https://api.smith.langchain.com",
      ),
    );

    for (const connectionUri of connectionUris) {
      expect(serialized).not.toContain(connectionUri);
      expect(serialized).not.toContain(
        connectionUri.match(/:[^:@/]+@/u)?.[0] ?? "unreachable-password",
      );
    }
    expect(serialized.match(/REDACTED:URI_PASSWORD/gu)).toHaveLength(
      connectionUris.length,
    );
    expect(serialized).toContain("postgresql://reader:");
    expect(serialized).toContain("@db.example/prod");
  });

  test("retains full message text without truncation", () => {
    const longText = "durable context ".repeat(10_000);
    const result = compactLangSmithRuns(
      [
        createRun({
          inputs: { messages: [{ content: longText, role: "user" }] },
          outputs: {
            messages: [{ content: longText, role: "assistant" }],
          },
        }),
      ],
      { id: null, name: "example-project" },
      "https://api.smith.langchain.com",
    );

    expect(result.threads[0]?.turns[0]?.user).toEqual([longText]);
    expect(result.threads[0]?.turns[0]?.assistant).toEqual([longText]);
  });

  test("creates deterministic opaque thread filename identifiers", () => {
    const remoteThreadId = "../../private/customer-thread-id";
    const identifier = createThreadFileIdentifier(remoteThreadId);

    expect(identifier).toMatch(/^thread-[a-f0-9]{24}$/u);
    expect(identifier).not.toContain("customer-thread-id");
    expect(createThreadFileIdentifier(remoteThreadId)).toBe(identifier);
    expect(createThreadFileIdentifier(`${remoteThreadId}-other`)).not.toBe(
      identifier,
    );
    expect(sanitizePathSegment(remoteThreadId)).toBe(identifier);
  });
});

function createRun(
  overrides: {
    error?: string;
    appPath?: string;
    endTime?: string;
    id?: string;
    inputs?: Record<string, unknown>;
    name?: string;
    outputs?: Record<string, unknown>;
    runType?: string;
    startTime?: string;
    status?: string;
    threadId?: string;
    traceId?: string;
  } = {},
): LangSmithRunRecord {
  const id = overrides.id ?? "run-1";
  return {
    app_path: overrides.appPath ?? `/o/test/projects/p/test/r/${id}`,
    end_time: overrides.endTime ?? "2026-07-15T00:01:00.000Z",
    error: overrides.error,
    extra: {
      metadata: {
        agent_name: "codex",
        cwd: "/Users/example/project",
        model: "gpt-5.6-sol",
        thread_id: overrides.threadId ?? "thread-1",
        turn_id: "turn-1",
        turn_number: 1,
      },
    },
    id,
    inputs: overrides.inputs ?? {
      messages: [{ content: "user", role: "user" }],
    },
    name: overrides.name ?? "coding-agent-turn",
    outputs: overrides.outputs ?? {
      messages: [{ content: "assistant", role: "assistant" }],
    },
    run_type: overrides.runType ?? "chain",
    start_time: overrides.startTime ?? "2026-07-15T00:00:00.000Z",
    status: overrides.status ?? (overrides.error ? "error" : "success"),
    total_tokens: 100,
    trace_id: overrides.traceId ?? id,
  };
}
