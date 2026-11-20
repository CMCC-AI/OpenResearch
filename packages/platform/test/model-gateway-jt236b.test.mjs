import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelGateway } from "../src/model-gateway.mjs";

function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function runStreamRequest(file, modelId, chunks) {
  const settlements = [];
  const pending = [];
  const handle = modelGateway({
    pool: {
      query: async () => ({
        rows: [{ user_id: "user", workspace_id: "workspace" }],
      }),
    },
    quota: {
      reserve: async () => "request-id",
      upstream: async () => {},
      settle: async (...args) => settlements.push(args),
      pending: async (...args) => pending.push(args),
    },
    settings: { enabled: true, modelsFile: file },
    limit: async () => {},
    fetcher: async () => sseResponse(chunks),
  });
  const req = Readable.from([
    Buffer.from(
      JSON.stringify({
        model: modelId,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    ),
  ]);
  req.method = "POST";
  req.headers = {
    authorization: "Bearer " + "x".repeat(43),
    "content-type": "application/json",
  };
  const res = new PassThrough();
  const output = [];
  res.on("data", (chunk) => output.push(chunk.toString()));
  res.setHeader = () => {};
  res.writeHead = () => {};
  res.headersSent = false;
  await handle(req, res, "/api/platform/model-gateway/v1/chat/completions");
  return { settlements, pending, body: output.join("") };
}

test("jt236b stream EOF without [DONE] settles quota and appends [DONE]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-jt236b-"));
  const file = join(dir, "models.json");
  await writeFile(
    file,
    JSON.stringify({
      models: [
        {
          id: "jt236b",
          model: "jt236b",
          apiKey: "never-leak",
          baseUrl: "http://8.130.156.14:8000/jt236b/v1",
          contextTokens: 131072,
          maxOutputTokens: 16384,
        },
        {
          id: "other-model",
          model: "other-model",
          apiKey: "never-leak",
          baseUrl: "https://upstream.invalid/v1",
          contextTokens: 131072,
          maxOutputTokens: 16384,
        },
      ],
    }),
  );
  try {
    const validChunks = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":50,"completion_tokens":23,"total_tokens":73}}\n\n',
    ];

    const jt = await runStreamRequest(file, "jt236b", validChunks);
    assert.deepEqual(jt.settlements, [["request-id", 73]]);
    assert.deepEqual(jt.pending, []);
    assert.ok(jt.body.endsWith("data: [DONE]\n\n"));

    const other = await runStreamRequest(file, "other-model", validChunks);
    assert.deepEqual(other.settlements, []);
    assert.deepEqual(other.pending, [["request-id", "usage_unconfirmed"]]);
    assert.ok(!other.body.includes("data: [DONE]"));

    const truncated = await runStreamRequest(file, "jt236b", [
      ...validChunks,
      'data: {"partial":',
    ]);
    assert.deepEqual(truncated.settlements, []);
    assert.deepEqual(truncated.pending, [["request-id", "usage_unconfirmed"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
