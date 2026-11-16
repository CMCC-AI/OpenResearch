import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelGateway } from "../src/model-gateway.mjs";

test("gateway failures do not cause repeated uncertain reservations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-failures-"));
  const file = join(dir, "models.json");
  await writeFile(
    file,
    JSON.stringify({
      models: [
        {
          id: "test",
          model: "test",
          apiKey: "never-leak",
          baseUrl: "https://upstream.invalid/v1",
          contextTokens: 100,
          maxOutputTokens: 10,
        },
      ],
    }),
  );
  try {
    for (const [code, released, errors] of [
      ["UND_ERR_CONNECT_TIMEOUT", true],
      ["ENOTFOUND", true],
      ["ECONNREFUSED", true],
      ["ECONNRESET", false],
      ["UND_ERR_HEADERS_TIMEOUT", false],
      ["UND_ERR_BODY_TIMEOUT", false],
      ["UNKNOWN", false],
      [
        "AGGREGATE_SAFE",
        true,
        [{ code: "ECONNREFUSED" }, { code: "ENETUNREACH" }],
      ],
      [
        "AGGREGATE_MIXED",
        false,
        [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }],
      ],
      ["AGGREGATE_EMPTY", false, []],
    ]) {
      await t.test(code, async () => {
        const settlements = [],
          pending = [];
        const handle = modelGateway({
          pool: {
            query: async () => ({
              rows: [{ user_id: "user", workspace_id: "workspace" }],
            }),
          },
          quota: {
            reserve: async () => "request-id",
            settle: async (...args) => settlements.push(args),
            pending: async (...args) => pending.push(args),
          },
          settings: { enabled: true, modelsFile: file },
          limit: async () => {},
          fetcher: async () => {
            throw new TypeError("fetch failed", {
              cause: Object.assign(new Error("private upstream details"), {
                code,
                errors,
              }),
            });
          },
        });
        const req = Readable.from([
          Buffer.from(
            JSON.stringify({
              model: "test",
              messages: [{ role: "user", content: "hi" }],
            }),
          ),
        ]);
        req.method = "POST";
        req.headers = {
          authorization: "Bearer " + "x".repeat(43),
          "content-type": "application/json",
        };
        const res = new EventEmitter();
        res.setHeader = () => {};
        res.headersSent = false;
        await assert.rejects(
          handle(req, res, "/api/platform/model-gateway/v1/chat/completions"),
          (error) => {
            assert.equal(
              error.status,
              424,
              "SDK must not automatically retry this failure",
            );
            assert.match(error.message, /request-id/);
            assert.ok(!error.message.includes("private upstream"));
            return true;
          },
        );
        assert.deepEqual(
          settlements,
          released
            ? [["request-id", 0, null, "connection_not_established"]]
            : [],
        );
        assert.deepEqual(
          pending,
          released ? [] : [["request-id", "usage_unconfirmed"]],
        );
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
