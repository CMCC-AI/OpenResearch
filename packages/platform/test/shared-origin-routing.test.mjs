import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration, createPlatform } from "../src/server.mjs";

const get = (port, path, host) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

test("shared-origin mode serves portal login routes from publicDir and app routes from ui dist", async () => {
  const uiDir = await mkdtemp(join(tmpdir(), "platform-shared-ui-"));
  const inlineBase = "document.write('<base href=\"/\">');";
  const inlineTheme = "document.documentElement.dataset.theme = 'light';";
  const hashOf = (code) =>
    `'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`;
  await mkdir(join(uiDir, "assets"), { recursive: true });
  await writeFile(
    join(uiDir, "index.html"),
    `<!doctype html><html><head><script>${inlineBase}</script><script>${inlineTheme}</script><script type="module" src="./assets/app.js"></script></head><body><div id="root"></div></body></html>`,
  );
  await writeFile(join(uiDir, "assets/app.js"), "console.log('app');");

  const config = configuration({
    DATABASE_URL: "postgres://unused",
    PLATFORM_ORIGIN: "http://localhost:5400",
    OPENRESEARCH_APP_ORIGIN: "http://localhost:5400",
    PRIVATE_USER_SPACES: "true",
    MANAGED_EXECUTORS: "true",
    PRIVATE_SPACE_ROUTING: "shared-origin",
    ORX_UI_DIST: uiDir,
  });
  const pool = { query: async () => ({ rows: [] }), end: async () => {} };
  const app = await createPlatform(config, pool);
  await new Promise((done) => app.server.listen(0, "127.0.0.1", done));
  const { port } = app.server.address();
  config.origin = new URL(`http://localhost:${port}`);
  config.appOrigin = config.origin.origin;
  const host = `localhost:${port}`;
  try {
    for (const portalPath of ["/", "/_account/login"]) {
      const response = await get(port, portalPath, host);
      assert.equal(response.status, 200, portalPath);
      assert.match(response.text, /\/platform\.js/);
      assert.match(
        response.headers["content-security-policy"],
        /script-src 'self';.*base-uri 'none'/,
      );
    }

    const portalScript = await get(port, "/platform.js", host);
    assert.equal(portalScript.status, 200);
    assert.match(portalScript.text, /administrationUrl/);

    for (const appPath of ["/projects", "/admin/users", "/settings/account"]) {
      const response = await get(port, appPath, host);
      assert.equal(response.status, 200, appPath);
      assert.match(response.text, /<div id="root"><\/div>/);
      const csp = response.headers["content-security-policy"];
      assert.ok(csp.includes(hashOf(inlineBase)), csp);
      assert.ok(csp.includes(hashOf(inlineTheme)), csp);
      assert.ok(csp.includes("base-uri 'self'"), csp);
    }

    const asset = await get(port, "/assets/app.js", host);
    assert.equal(asset.status, 200);
    assert.match(asset.headers["content-type"], /application\/javascript/);
    assert.equal(asset.text, "console.log('app');");

    const runtime = await get(port, "/_orx/runtime", host);
    assert.equal(runtime.status, 200);
    assert.deepEqual(JSON.parse(runtime.text), {
      kind: "local",
      version: "platform",
      accountUrl: `http://localhost:${port}`,
    });

    const missingApi = await get(port, "/api/auth/unknown", host);
    assert.equal(missingApi.status, 404);

    // Subdomain mode must keep redirecting /projects back to the portal home.
    config.sharedOriginSpaces = false;
    const subdomainRedirect = await get(port, "/projects", host);
    assert.equal(subdomainRedirect.status, 303);
    assert.equal(subdomainRedirect.headers.location, "/");
  } finally {
    await app.close();
    await rm(uiDir, { recursive: true, force: true });
  }
});
