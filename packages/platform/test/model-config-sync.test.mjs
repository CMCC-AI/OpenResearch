import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { Tunnel } from "../src/tunnel.mjs";
import { connectRunner, createModelConfigSyncer } from "../src/runner.mjs";

test("Tunnel.notify delivers control frames when open and returns false when closed", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  try {
    await new Promise((resolve) => wss.once("listening", resolve));
    const port = wss.address().port;
    let received;
    const serverSocketPromise = new Promise((resolve) => {
      wss.once("connection", (ws) => resolve(ws));
    });

    const { WebSocket } = await import("ws");
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const messagePromise = new Promise((resolve) => {
      client.once("message", (data) => {
        received = JSON.parse(data.toString());
        resolve();
      });
    });

    const serverWs = await serverSocketPromise;
    const tunnel = new Tunnel(serverWs);
    assert.equal(tunnel.notify({ type: "sync-model-config" }), true);
    await messagePromise;
    assert.deepEqual(received, { type: "sync-model-config" });

    client.close();
    await new Promise((resolve) => serverWs.once("close", resolve));
    assert.equal(tunnel.notify({ type: "sync-model-config" }), false);
  } finally {
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("connectRunner handles sync-model-config without closing the tunnel", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  try {
    await new Promise((resolve) => wss.once("listening", resolve));
    const port = wss.address().port;
    let syncCalls = 0;
    let closed = false;
    let syncedResolve;
    const syncedPromise = new Promise((resolve) => {
      syncedResolve = resolve;
    });

    const serverSocketPromise = new Promise((resolve) => {
      wss.once("connection", (ws) => resolve(new Tunnel(ws)));
    });

    const runner = connectRunner({
      platform: `http://127.0.0.1:${port}`,
      credential: "A".repeat(43),
      upstream: "http://127.0.0.1:4791",
      syncModelConfig: () => {
        syncCalls += 1;
        syncedResolve();
      },
    });
    runner.on("close", () => {
      closed = true;
    });

    const tunnel = await serverSocketPromise;
    assert.equal(tunnel.notify({ type: "sync-model-config" }), true);
    await syncedPromise;
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(syncCalls, 1);
    assert.equal(closed, false);
    runner.terminate();
  } finally {
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("createModelConfigSyncer coalesces concurrent triggers and refreshes opencode harnesses", async () => {
  let prepareCount = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const refreshedUrls = [];

  const sync = createModelConfigSyncer({
    home: "/tmp/test-home",
    base: "http://127.0.0.1:20281",
    secret: "secret",
    upstream: "http://127.0.0.1:4791",
    prepare: async () => {
      prepareCount += 1;
      if (prepareCount === 1) await firstGate;
    },
    fetcher: async (url) => {
      refreshedUrls.push(String(url));
      return { ok: true };
    },
  });

  const first = sync();
  const second = sync();
  const third = sync();
  releaseFirst();
  await Promise.all([first, second, third]);

  assert.equal(prepareCount, 2);
  assert.deepEqual(refreshedUrls, [
    "http://127.0.0.1:4791/api/harnesses?refresh=1&harness=opencode",
    "http://127.0.0.1:4791/api/harnesses?refresh=1&harness=opencode",
  ]);
});
