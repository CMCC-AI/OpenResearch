import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { HttpError, check } from "./security.mjs";

export const MAX_BODY = 8 * 1024 * 1024;
export function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BODY) {
    ws.terminate();
    throw new Error("Tunnel unavailable or overloaded");
  }
  ws.send(JSON.stringify(message));
}
export function decoded(value) {
  check(
    typeof value === "string" && value.length <= 1024 * 1024,
    400,
    "Invalid tunnel frame",
  );
  return Buffer.from(value, "base64");
}
export async function body(req, max = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    check(size <= max, 413, "请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export class Tunnel {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.reading = 0;
    ws.on("error", () => {});
    ws.on("close", () => {
      for (const item of this.pending.values()) item.fail();
      this.pending.clear();
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const item = this.pending.get(msg.id);
        if (item) item.message(msg);
      } catch {
        ws.terminate();
      }
    });
  }
  open(message, handler) {
    check(this.pending.size < 64, 429, "工作空间并发已达上限");
    const id = randomUUID();
    this.pending.set(id, handler);
    try {
      send(this.ws, { ...message, id });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return id;
  }
  cancel(id) {
    this.pending.delete(id);
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        send(this.ws, { type: "cancel", id });
      } catch {
        this.ws.terminate();
      }
    }
  }
  async http(req, res, session, authorize) {
    check(
      this.reading < 8 && this.pending.size < 64,
      429,
      "工作空间并发已达上限",
    );
    this.reading++;
    let payload;
    try {
      payload = await body(req);
    } finally {
      this.reading--;
    }
    // Uploads can outlive membership/session revocation; recheck before dispatch.
    await authorize();
    let count = 0;
    let started = false;
    let stream = false;
    let id;
    let timeout;
    let recheck;
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(recheck);
      if (id) this.cancel(id);
    };
    const fail = () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end('{"error":"执行器连接中断"}');
      } else res.destroy();
      cleanup();
    };
    id = this.open(
      {
        type: "http",
        path: req.url,
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"],
          range: req.headers.range,
          accept: req.headers.accept,
        },
        body: payload.toString("base64"),
      },
      {
        session,
        fail,
        message: (msg) => {
          if (msg.type === "head") {
            check(
              !started &&
                Number.isInteger(msg.status) &&
                msg.status >= 200 &&
                msg.status <= 599,
            );
            started = true;
            stream = (msg.headers?.["content-type"] || "").includes(
              "text/event-stream",
            );
            const headers = {
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            };
            for (const name of [
              "content-type",
              "content-disposition",
              "content-range",
              "accept-ranges",
            ]) {
              if (typeof msg.headers?.[name] === "string")
                headers[name] = msg.headers[name];
            }
            // Research artifacts must not execute scripts with the workspace's authority.
            headers["content-security-policy"] =
              "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
            res.writeHead(msg.status, headers);
            res.flushHeaders();
            clearTimeout(timeout);
            timeout = setTimeout(fail, stream ? 30 * 60_000 : 120_000);
          } else if (msg.type === "chunk") {
            check(started);
            const chunk = decoded(msg.body);
            count += chunk.length;
            check(stream || count <= 64 * 1024 * 1024);
            if (res.writableLength > MAX_BODY) return fail();
            res.write(chunk);
          } else if (msg.type === "end") {
            res.end();
            cleanup();
          } else if (msg.type === "error") fail();
        },
      },
    );
    timeout = setTimeout(fail, 120_000);
    recheck = setInterval(() => authorize().catch(fail), 5000);
    res.on("close", cleanup);
  }
  socket(req, browser, session, authorize) {
    let id;
    let interval;
    const fail = () => {
      browser.close(1008, "Access ended");
      clearInterval(interval);
      if (id) this.cancel(id);
    };
    id = this.open(
      { type: "ws-open", path: req.url },
      {
        session,
        fail,
        message: (msg) => {
          if (msg.type === "ws-data") {
            if (browser.bufferedAmount > MAX_BODY) return fail();
            if (browser.readyState === WebSocket.OPEN)
              browser.send(decoded(msg.body), { binary: !!msg.binary });
          } else if (["ws-close", "error"].includes(msg.type)) fail();
        },
      },
    );
    browser.on("message", (data, binary) => {
      try {
        send(this.ws, {
          type: "ws-data",
          id,
          body: data.toString("base64"),
          binary,
        });
      } catch {
        fail();
      }
    });
    browser.on("error", fail);
    browser.on("close", fail);
    interval = setInterval(() => authorize().catch(fail), 5000);
  }
  revokeSession(hash) {
    for (const item of this.pending.values())
      if (item.session === hash) item.fail();
  }
  close() {
    for (const item of this.pending.values()) item.fail();
    this.pending.clear();
    this.ws.terminate();
  }
}
