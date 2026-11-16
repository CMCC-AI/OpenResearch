import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { connectRunner } from "../src/runner.mjs";
import { Tunnel, responseBodyLimit } from "../src/tunnel.mjs";
const filePath = "/api/projects/project/files/file?path=paper%2Ffont.otf";
test("artifact responses allow 128 MiB while ordinary JSON keeps its 64 MiB cap", () => {
  assert.equal(responseBodyLimit("GET", filePath), 128 * 1024 * 1024);
  assert.equal(responseBodyLimit("HEAD", filePath), 128 * 1024 * 1024);
  for (const [method, path] of [
    ["POST", filePath],
    ["GET", "/api/projects/project/files"],
    ["GET", "/api/chat/sessions/session/messages"],
  ])
    assert.equal(responseBodyLimit(method, path), 64 * 1024 * 1024);
});
test(
  "real runner applies downstream backpressure, preserves large file hashes, and cancels stalled reads",
  { timeout: 30000 },
  async (t) => {
    let size = 20 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0xa7);
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      Readable.from(
        (function* () {
          for (let left = size; left > 0; left -= chunk.length)
            yield chunk.subarray(0, Math.min(left, chunk.length));
        })(),
      ).pipe(res);
    });
    const gateway = http.createServer();
    const wss = new WebSocketServer({
      server: gateway,
      path: "/_platform/runner",
      perMessageDeflate: false,
    });
    let tunnel, runner;
    wss.on("connection", (ws) => {
      tunnel = new Tunnel(ws);
    });
    t.after(async () => {
      runner?.terminate();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      upstream.closeAllConnections();
      gateway.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => upstream.close(resolve)),
        new Promise((resolve) => gateway.close(resolve)),
      ]);
    });
    upstream.listen(0, "127.0.0.1");
    gateway.listen(0, "127.0.0.1");
    await Promise.all([
      once(upstream, "listening"),
      once(gateway, "listening"),
    ]);
    runner = connectRunner({
      platform: `http://127.0.0.1:${gateway.address().port}`,
      credential: "synthetic",
      upstream: `http://127.0.0.1:${upstream.address().port}`,
    });
    await once(runner, "open");
    class SlowResponse extends EventEmitter {
      headersSent = false;
      writableLength = 0;
      peak = 0;
      bytes = 0;
      digest = createHash("sha256");
      stall = false;
      writeHead(status) {
        this.headersSent = true;
        assert.equal(status, 200);
      }
      flushHeaders() {}
      write(value, callback) {
        this.bytes += value.length;
        this.digest.update(value);
        this.writableLength += value.length;
        this.peak = Math.max(this.peak, this.writableLength);
        this.emit("chunk");
        if (!this.stall)
          setTimeout(() => {
            this.writableLength -= value.length;
            callback?.();
          }, 1);
        return false;
      }
      end() {
        this.emit("finished");
      }
      destroy() {
        this.emit("failed");
      }
    }
    const request = () =>
      Object.assign(Readable.from([]), {
        method: "GET",
        url: filePath,
        headers: {},
      });
    for (size of [20 * 1024 * 1024, 65 * 1024 * 1024]) {
      const response = new SlowResponse();
      const done = Promise.race([
        once(response, "finished"),
        once(response, "failed").then(() => {
          throw Error("Download truncated");
        }),
      ]);
      await tunnel.http(request(), response, "session", async () => {});
      await done;
      const expected = createHash("sha256");
      for (let left = size; left > 0; left -= chunk.length)
        expected.update(chunk.subarray(0, Math.min(left, chunk.length)));
      assert.equal(response.bytes, size);
      assert.equal(response.digest.digest("hex"), expected.digest("hex"));
      assert.ok(
        response.peak <= 64 * 1024,
        `Unbounded response queue: ${response.peak}`,
      );
      assert.equal(tunnel.pending.size, 0);
    }
    const stalled = new SlowResponse();
    stalled.stall = true;
    const first = once(stalled, "chunk");
    await tunnel.http(request(), stalled, "session", async () => {});
    await first;
    stalled.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(tunnel.pending.size, 0);
    assert.ok(stalled.bytes <= 64 * 1024);
    size = 1;
    const next = new SlowResponse();
    const finished = once(next, "finished");
    await tunnel.http(request(), next, "session", async () => {});
    await finished;
    assert.equal(next.bytes, 1);
    // Old gateways omit the capability and must not wait for acknowledgements.
    const serverSocket = [...wss.clients][0];
    const legacy = [];
    const ended = new Promise((resolve) => {
      const receive = (data) => {
        const message = JSON.parse(data.toString());
        if (message.id !== "legacy") return;
        legacy.push(message);
        if (message.type === "end") {
          serverSocket.off("message", receive);
          resolve();
        }
      };
      serverSocket.on("message", receive);
    });
    serverSocket.send(
      JSON.stringify({
        type: "http",
        id: "legacy",
        method: "GET",
        path: filePath,
        body: "",
      }),
    );
    await ended;
    assert.equal(legacy[0].flowControl, undefined);
    assert.equal(
      Buffer.from(
        legacy.find((message) => message.type === "chunk").body,
        "base64",
      ).length,
      1,
    );
  },
);
