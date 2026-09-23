import http from "node:http";
import { pathToFileURL } from "node:url";
import { createPool, transaction } from "./db.mjs";
import { hash, token, id } from "./security.mjs";

// This process alone owns access to Docker. No user-defined images or paths.
export function docker(method, path, body, binary = false) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? undefined
        : binary
          ? body
          : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
        path: `/v1.41${path}`,
        method,
        headers: payload
          ? {
              "content-type": binary ? "application/x-tar" : "application/json",
              "content-length": payload.length,
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            const error = new Error(`Docker ${method} ${res.statusCode}`);
            error.status = res.statusCode;
            reject(error);
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            reject(new Error("Invalid Docker response"));
          }
        });
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error("Docker timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

// Install a credential with the executor UID and private permissions; never put it in Env.
export function credentialArchive(secret) {
  const header = Buffer.alloc(512);
  header.write(".platform-token");
  const octal = (value, offset, length) =>
    header.write(
      value.toString(8).padStart(length - 1, "0") + "\0",
      offset,
      length,
    );
  octal(0o600, 100, 8);
  octal(1000, 108, 8);
  octal(1000, 116, 8);
  octal(secret.length + 1, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  octal(
    header.reduce((a, b) => a + b, 0),
    148,
    8,
  );
  const content = Buffer.alloc(512);
  content.write(secret + "\n");
  return Buffer.concat([header, content, Buffer.alloc(1024)]);
}

export function runtimeConfig(workspace, env) {
  if (!/^[0-9a-f-]{36}$/.test(workspace)) throw new Error("Invalid workspace");
  if (!env.MANAGED_EXECUTOR_IMAGE)
    throw new Error("MANAGED_EXECUTOR_IMAGE is required");
  return {
    Image: env.MANAGED_EXECUTOR_IMAGE,
    User: "1000:1000",
    Labels: {
      "openresearch.managed": "true",
      "openresearch.workspace": workspace,
    },
    Env: [
      `PLATFORM_ORIGIN=${env.PLATFORM_ORIGIN}`,
      `PLATFORM_CONNECT_URL=${env.MANAGED_CONNECT_URL || env.PLATFORM_ORIGIN}`,
      "RUNNER_TOKEN_FILE=/home/node/.platform-token",
      `ORX_DEEP_LITERATURE_URL=${env.ORX_DEEP_LITERATURE_URL || "http://host.docker.internal:3000"}`,
      `ORX_DEEP_LITERATURE_WEB_URL=${env.ORX_DEEP_LITERATURE_WEB_URL || "http://localhost:3000"}`,
    ],
    HostConfig: {
      Binds: [`orx-managed-${workspace}:/home/node`],
      ExtraHosts: ["host.docker.internal:host-gateway"],
      RestartPolicy: { Name: "unless-stopped" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 1000000000,
      PidsLimit: 256,
      Init: true,
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
    },
    Healthcheck: {
      Test: [
        "CMD",
        "node",
        "-e",
        'fetch("http://127.0.0.1:4791/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
      ],
      Interval: 5000000000,
      Timeout: 3000000000,
      Retries: 12,
      StartPeriod: 30000000000,
    },
  };
}

export async function reconcile(db, job, env = process.env, call = docker) {
  const workspace = job.workspace_id;
  const name = `orx-managed-${workspace}`;
  let container;
  try {
    container = await call("GET", `/containers/${name}/json`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (
    container &&
    (container.Config.Labels?.["openresearch.workspace"] !== workspace ||
      container.Config.Labels?.["openresearch.managed"] !== "true")
  )
    throw new Error("Container ownership mismatch");
  if (job.desired === "deleted") {
    if (container) await call("DELETE", `/containers/${name}?force=true`);
    await db.query(
      "UPDATE workspace_runtimes SET status='deleted',error=NULL,checked_at=now() WHERE workspace_id=$1",
      [workspace],
    );
    return;
  }
  if (!container) {
    await call(
      "POST",
      `/containers/create?name=${name}`,
      runtimeConfig(workspace, env),
    );
    container = { State: { Running: false } };
  }
  if (container.State.Running && job.status === "queued") {
    await call("POST", `/containers/${name}/stop?t=5`);
    container.State.Running = false;
  }
  if (!container.State.Running) {
    const secret = token();
    await call(
      "PUT",
      `/containers/${name}/archive?path=/home/node`,
      credentialArchive(secret),
      true,
    );
    await db.query(
      "INSERT INTO runners(id,workspace_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '90 days') ON CONFLICT(workspace_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,last_seen=NULL",
      [id(), workspace, hash(secret)],
    );
    await call("POST", `/containers/${name}/start`);
    container.State.Health = undefined;
  }
  const health = container.State.Health?.Status;
  const state =
    health === "healthy"
      ? "ready"
      : health === "unhealthy"
        ? "failed"
        : "starting";
  await db.query(
    "UPDATE workspace_runtimes SET status=$2,error=$3,checked_at=now() WHERE workspace_id=$1",
    [
      workspace,
      state,
      health === "unhealthy"
        ? "研究环境健康检查失败，请重试或联系管理员"
        : null,
    ],
  );
}

async function main() {
  const pool = createPool(process.env.DATABASE_URL);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stopping = true;
    });
  while (!stopping) {
    let workspace;
    try {
      await transaction(pool, async (db) => {
        const { rows } = await db.query(
          "SELECT * FROM workspace_runtimes WHERE status<>'deleted' AND (status<>'failed' OR desired='deleted') AND (checked_at IS NULL OR checked_at<now()-interval '10 seconds') ORDER BY checked_at NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED",
        );
        if (!rows.length) return;
        workspace = rows[0].workspace_id;
        await reconcile(db, rows[0]);
      });
    } catch (error) {
      console.error("Managed executor operation failed", error.message);
      if (workspace)
        await pool
          .query(
            "UPDATE workspace_runtimes SET status='failed',error=$2,checked_at=now() WHERE workspace_id=$1",
            [workspace, "环境准备失败，请重试；管理员可检查供给服务日志"],
          )
          .catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await pool.end();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.exitCode = 1;
  });
