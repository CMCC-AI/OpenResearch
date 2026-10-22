import { readFile, stat } from "node:fs/promises";
import { acquireRunnerLock } from "./runner-lock.mjs";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { check, permitted } from "./security.mjs";
import {
  MAX_BODY,
  MAX_RUNNER_FRAME,
  requestBodyLimit,
  decoded,
  send,
} from "./tunnel.mjs";
import { pathToFileURL } from "node:url";

// No public listener: this connector only reaches a fixed local OpenResearch instance.
export function connectRunner({
  platform,
  connect = platform,
  credential,
  upstream,
}) {
  const publicOrigin = new URL(platform);
  const remote = new URL("/_platform/runner", connect);
  check(
    remote.protocol === "https:" ||
      (remote.protocol === "http:" &&
        ["localhost", "127.0.0.1", "host.docker.internal"].includes(
          remote.hostname,
        )),
  );
  remote.protocol = remote.protocol === "https:" ? "wss:" : "ws:";
  const local = new URL(upstream);
  check(
    local.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(local.hostname) &&
      local.pathname === "/" &&
      !local.search &&
      !local.username &&
      !local.password,
  );
  const ws = new WebSocket(remote, {
    headers: {
      authorization: `Bearer ${credential}`,
      host: publicOrigin.host,
    },
    maxPayload: MAX_RUNNER_FRAME,
    handshakeTimeout: 10000,
    perMessageDeflate: false,
  });
  const active = new Map();
  ws.on("error", () => {});
  const cancel = (id) => {
    const job = active.get(id);
    job?.abort?.();
    job?.close?.();
    active.delete(id);
  };
  ws.on("close", () => {
    for (const id of active.keys()) cancel(id);
  });
  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
      check(typeof msg.id === "string");
      if (msg.type === "cancel") return cancel(msg.id);
      if (msg.type === "ws-data") {
        const socket = active.get(msg.id);
        if (socket?.readyState === WebSocket.OPEN) {
          check(socket.bufferedAmount <= MAX_BODY);
          socket.send(decoded(msg.body), { binary: !!msg.binary });
        } else if (socket?.readyState === WebSocket.CONNECTING) {
          socket.queuedBytes =
            (socket.queuedBytes || 0) + decoded(msg.body).length;
          check(socket.queuedBytes <= 1024 * 1024);
          socket.once("open", () =>
            socket.send(decoded(msg.body), { binary: !!msg.binary }),
          );
        }
        return;
      }
      check(active.size < 64 && !active.has(msg.id), 429);
      check(
        typeof msg.path === "string" &&
          msg.path.startsWith("/api/") &&
          !msg.path.includes("\\"),
      );
      const target = new URL(msg.path, local);
      check(
        target.origin === local.origin &&
          permitted(msg.method || "GET", target.pathname),
        403,
      );
      if (msg.type === "http") {
        const controller = new AbortController();
        active.set(msg.id, controller);
        const limit = requestBodyLimit(msg.method, target.pathname);
        check(
          typeof msg.body === "string" &&
            msg.body.length <= Math.ceil(limit / 3) * 4,
        );
        const payload = Buffer.from(msg.body, "base64");
        check(payload.length <= limit, 413);
        const response = await fetch(target, {
          method: msg.method,
          redirect: "manual",
          headers: {
            ...Object.fromEntries(
              Object.entries(msg.headers || {}).filter(
                ([key, value]) =>
                  ["content-type", "range", "accept"].includes(key) &&
                  typeof value === "string",
              ),
            ),
            origin: local.origin,
          },
          body: ["GET", "HEAD"].includes(msg.method) ? undefined : payload,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(31 * 60_000),
          ]),
        });
        send(ws, {
          type: "head",
          id: msg.id,
          status: response.status,
          headers: Object.fromEntries(response.headers),
        });
        if (response.body)
          for await (const chunk of response.body) {
            for (let i = 0; i < chunk.length; i += 64 * 1024)
              send(ws, {
                type: "chunk",
                id: msg.id,
                body: Buffer.from(chunk.subarray(i, i + 64 * 1024)).toString(
                  "base64",
                ),
              });
          }
        send(ws, { type: "end", id: msg.id });
        active.delete(msg.id);
      } else if (msg.type === "ws-open") {
        target.protocol = "ws:";
        const socket = new WebSocket(target, {
          origin: local.origin,
          maxPayload: 1024 * 1024,
          handshakeTimeout: 10000,
          perMessageDeflate: false,
        });
        active.set(msg.id, socket);
        socket.on("message", (chunk, binary) => {
          try {
            send(ws, {
              type: "ws-data",
              id: msg.id,
              body: chunk.toString("base64"),
              binary,
            });
          } catch {
            socket.terminate();
          }
        });
        socket.on("error", () => {});
        socket.on("close", () => {
          active.delete(msg.id);
          if (ws.readyState === WebSocket.OPEN) {
            try {
              send(ws, { type: "ws-close", id: msg.id });
            } catch {
              ws.terminate();
            }
          }
        });
      } else throw new Error("Unknown protocol message");
    } catch {
      if (msg?.id) {
        cancel(msg.id);
        if (ws.readyState === WebSocket.OPEN) {
          try {
            send(ws, { type: "error", id: msg.id });
          } catch {
            ws.terminate();
          }
        }
      } else ws.terminate();
    }
  });
  return ws;
}

async function main() {
  const platform = process.env.PLATFORM_ORIGIN;
  const connect = process.env.PLATFORM_CONNECT_URL || platform;
  const upstream = process.env.ORX_UPSTREAM || "http://127.0.0.1:4791";
  const file = process.env.RUNNER_TOKEN_FILE;
  check(platform && file, 400, "Set PLATFORM_ORIGIN and RUNNER_TOKEN_FILE");
  if (process.platform !== "win32")
    check(
      ((await stat(file)).mode & 0o077) === 0,
      400,
      "Credential file must not be readable by other users",
    );
  const credential = (await readFile(file, "utf8")).trim();
  check(/^[A-Za-z0-9_-]{43}$/.test(credential), 400, "Invalid credential file");
  // Each executor must have a private data directory, OS identity/container, and secrets.
  check(
    process.env.RUNNER_ISOLATION_ACK === "dedicated-workspace",
    400,
    "Use a dedicated isolated workspace; set RUNNER_ISOLATION_ACK=dedicated-workspace",
  );
  // Prevent accidental simultaneous attachment of one connector directory to two tenants.
  const state = resolve(process.env.RUNNER_STATE_DIR || ".runner-state");
  const releaseLock = await acquireRunnerLock(state);
  let stopping = false;
  let socket;
  const stop = async () => {
    stopping = true;
    socket?.terminate();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let failures = 0;
  while (!stopping) {
    socket = connectRunner({ platform, connect, credential, upstream });
    socket.on("open", () => {
      failures = 0;
      console.log("Executor connected");
    });
    await new Promise((done) => socket.once("close", done));
    if (!stopping)
      await new Promise((done) =>
        setTimeout(
          done,
          Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) +
            Math.random() * 500,
        ),
      );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Executor startup failed. Check configuration and dedicated state directory.",
    );
    process.exitCode = 1;
  });
