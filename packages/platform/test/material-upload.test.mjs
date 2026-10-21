import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { connectRunner } from "../src/runner.mjs";
import {
  Tunnel,
  body,
  requestBodyLimit,
  MAX_BODY,
  MAX_MATERIAL_UPLOAD,
} from "../src/tunnel.mjs";

const uploadPath = "/api/projects/project-1/materials/package-1/files";

test("only material file PUTs receive the 32 MiB body limit", async () => {
  assert.equal(
    requestBodyLimit("PUT", `${uploadPath}?path=folder%2Fpaper.pdf`),
    MAX_MATERIAL_UPLOAD,
  );
  for (const [method, path] of [
    ["POST", uploadPath],
    ["PUT", `${uploadPath}/extra`],
    ["POST", "/api/chat/sessions/session/message"],
    ["POST", "/api/projects/project-1/materials/package-1/finalize"],
  ])
    assert.equal(requestBodyLimit(method, path), MAX_BODY);
  await assert.rejects(body(Readable.from([Buffer.alloc(MAX_BODY + 1)])), {
    status: 413,
  });
  await assert.rejects(
    body(
      Readable.from([Buffer.alloc(MAX_MATERIAL_UPLOAD), Buffer.alloc(1)]),
      MAX_MATERIAL_UPLOAD,
    ),
    { status: 413 },
  );
});

test(
  "gateway and real runner deliver files above 8 MiB and at the 32 MiB boundary intact",
  { timeout: 30_000 },
  async (t) => {
    const received = [];
    const upstream = http.createServer(async (req, res) => {
      let bytes = 0;
      const digest = createHash("sha256");
      for await (const chunk of req) {
        bytes += chunk.length;
        digest.update(chunk);
      }
      received.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bytes, sha256: digest.digest("hex") }));
    });
    let tunnel;
    let authorized = 0;
    const gateway = http.createServer(async (req, res) => {
      try {
        await tunnel.http(req, res, "test-session", async () => {
          authorized++;
        });
      } catch (error) {
        res.writeHead(error.status || 500);
        res.end();
      }
    });
    const wss = new WebSocketServer({
      server: gateway,
      path: "/_platform/runner",
      perMessageDeflate: false,
    });
    let runner;
    t.after(async () => {
      runner?.terminate();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      upstream.closeAllConnections();
      gateway.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => upstream.close(resolve)),
        new Promise((resolve) => gateway.close(resolve)),
      ]);
    });
    wss.on("connection", (socket) => {
      tunnel = new Tunnel(socket);
    });
    upstream.listen(0, "127.0.0.1");
    gateway.listen(0, "127.0.0.1");
    await Promise.all([
      once(upstream, "listening"),
      once(gateway, "listening"),
    ]);
    const origin = `http://127.0.0.1:${gateway.address().port}`;
    runner = connectRunner({
      platform: origin,
      credential: "test-only",
      upstream: `http://127.0.0.1:${upstream.address().port}`,
    });
    await once(runner, "open");
    for (const size of [9 * 1024 * 1024, MAX_MATERIAL_UPLOAD]) {
      const payload = Buffer.alloc(size, 0xa7);
      const response = await fetch(
        `${origin}${uploadPath}?path=folder%2Fpaper.pdf`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: payload,
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        bytes: size,
        sha256: createHash("sha256").update(payload).digest("hex"),
      });
    }
    // A larger transport frame must not lift the ordinary API body cap.
    const serverSocket = [...wss.clients][0];
    const rejected = new Promise((resolve) => {
      const handler = (data) => {
        const message = JSON.parse(data.toString());
        if (message.id !== "oversized-chat") return;
        serverSocket.off("message", handler);
        resolve(message);
      };
      serverSocket.on("message", handler);
    });
    serverSocket.send(
      JSON.stringify({
        type: "http",
        id: "oversized-chat",
        method: "POST",
        path: "/api/chat/sessions/session/message",
        body: Buffer.alloc(MAX_BODY + 1).toString("base64"),
      }),
    );
    assert.equal((await rejected).type, "error");
    assert.equal(authorized, 2);
    assert.equal(received.length, 2);
    assert.ok(
      received.every(
        (path) => path === `${uploadPath}?path=folder%2Fpaper.pdf`,
      ),
    );
  },
);
