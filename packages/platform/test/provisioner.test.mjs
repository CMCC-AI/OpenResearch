import test from "node:test";
import assert from "node:assert/strict";
import {
  credentialArchive,
  reconcile,
  runtimeConfig,
} from "../src/provisioner.mjs";

const workspace = "11111111-1111-4111-8111-111111111111";
const env = {
  MANAGED_EXECUTOR_IMAGE: "executor:test",
  PLATFORM_ORIGIN: "http://localhost:5300",
};
test("managed configuration isolates storage, limits resources and keeps credentials out of environment", () => {
  const first = runtimeConfig(workspace, env);
  const second = runtimeConfig("22222222-2222-4222-8222-222222222222", env);
  assert.notDeepEqual(first.HostConfig.Binds, second.HostConfig.Binds);
  assert.equal(first.HostConfig.Memory, 1073741824);
  assert.equal(first.HostConfig.PortBindings, undefined);
  assert.equal(first.User, "1000:1000");
  const configured = runtimeConfig(workspace, {
    ...env,
    MANAGED_OPENCODE_CONFIG_FILE: "/srv/config/opencode.json",
  });
  assert(
    configured.HostConfig.Binds.includes(
      "/srv/config/opencode.json:/home/node/.config/opencode/opencode.json:ro",
    ),
  );
  assert.throws(
    () =>
      runtimeConfig(workspace, {
        ...env,
        MANAGED_OPENCODE_CONFIG_FILE: "/srv/config:rw",
      }),
    /absolute host path/,
  );
  const archive = credentialArchive("x".repeat(43));
  assert.equal(parseInt(archive.toString("ascii", 100, 107), 8), 0o600);
  assert.equal(parseInt(archive.toString("ascii", 108, 115), 8), 1000);
  assert.equal(archive.toString("ascii", 512, 556), "x".repeat(43) + "\n");
});
test("recovery of queued running container stops it before rotating credential", async () => {
  const calls = [];
  const db = { query: async (sql, args) => calls.push([sql, args]) };
  const call = async (method, path) => {
    calls.push([method, path]);
    if (method === "GET")
      return {
        Config: {
          Labels: {
            "openresearch.managed": "true",
            "openresearch.workspace": workspace,
          },
        },
        State: { Running: true },
      };
  };
  await reconcile(
    db,
    { workspace_id: workspace, desired: "running", status: "queued" },
    env,
    call,
  );
  assert(
    calls.findIndex((c) => c[1]?.endsWith?.("/stop?t=5")) <
      calls.findIndex((c) => c[0] === "PUT"),
  );
  assert(calls.some((c) => c[1]?.endsWith?.("/start")));
  assert(!calls.some((c) => c[1]?.includes?.("/containers/create")));
});
test("deletion removes only owned container and retains data volume", async () => {
  const calls = [];
  const call = async (method, path) => {
    calls.push([method, path]);
    if (method === "GET")
      return {
        Config: {
          Labels: {
            "openresearch.managed": "true",
            "openresearch.workspace": workspace,
          },
        },
        State: { Running: true },
      };
  };
  await reconcile(
    { query: async () => {} },
    { workspace_id: workspace, desired: "deleted" },
    env,
    call,
  );
  assert(calls.some((c) => c[0] === "DELETE" && c[1].includes("force=true")));
  assert(!calls.some((c) => c[1].includes("/volumes/")));
  await assert.rejects(
    reconcile(
      { query: async () => {} },
      { workspace_id: workspace, desired: "deleted" },
      env,
      async () => ({ Config: { Labels: {} } }),
    ),
    /ownership/,
  );
});

test("preserved original research uses a connector while new accounts get disjoint private volumes", () => {
  const legacy = runtimeConfig(workspace, {
    ...env,
    MANAGED_LEGACY_WORKSPACE: workspace,
    MANAGED_CONNECTOR_IMAGE: "platform:test",
    MANAGED_OPENCODE_CONFIG_DIR: "/srv/config",
    MANAGED_OPENCODE_AUTH_FILE: "/srv/auth.json",
  });
  assert.equal(legacy.Image, "platform:test");
  assert.equal(legacy.HostConfig.NetworkMode, "host");
  assert.deepEqual(legacy.Cmd, ["node", "src/connector-entry.mjs"]);
  assert.equal(legacy.HostConfig.Binds.length, 1);
  assert(!legacy.HostConfig.Binds.some((p) => p.includes("research")));
  const ordinary = runtimeConfig(workspace, env);
  assert.notEqual(ordinary.HostConfig.NetworkMode, "host");
  assert(ordinary.Env.includes("RUNNER_ISOLATION_ACK=dedicated-workspace"));
});

test("web-managed OpenCode mounts a read-only directory for atomic updates", () => {
  const configured = runtimeConfig(workspace, {
    ...env,
    MANAGED_OPENCODE_LIVE_CONFIG_DIR: "/srv/config",
    MANAGED_OPENCODE_CONFIG_FILE: "/srv/config/opencode.json",
  });
  assert(
    configured.HostConfig.Binds.includes(
      "/srv/config:/home/node/.config/opencode:ro",
    ),
  );
  assert(
    !configured.HostConfig.Binds.some((bind) =>
      bind.startsWith("/srv/config/opencode.json:"),
    ),
  );
  assert(!configured.Env.some((value) => value.startsWith("OPENCODE_CONFIG=")));
  assert.throws(() =>
    runtimeConfig(workspace, {
      ...env,
      MANAGED_OPENCODE_LIVE_CONFIG_DIR: "/srv/config:rw",
    }),
  );
});
