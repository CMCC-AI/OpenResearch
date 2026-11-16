import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { chromium } from "../ui/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(
  await realpath(
    new URL("../ui/node_modules/vite/package.json", import.meta.url),
  ),
);
const { build } = require("esbuild");
const source = await readFile(
  new URL("../ui/src/product/PersonalResearchGate.tsx", import.meta.url),
  "utf8",
);
const result = await build({
  stdin: {
    contents: `${source
      .replace(/import \{ cancelRuntimeRequests \}[^\n]+\n/, 'import { cancelRuntimeRequests, runtimeFetch } from "./src/runtimeRequest.ts";\n')
      .replace(
        "export function PersonalResearchGate",
        "function PersonalResearchGate",
      )
}
import {createRoot} from 'react-dom/client';
function Workspace() {
 const [draft,setDraft]=React.useState('');
 const [sent,setSent]=React.useState(false);
 return <><textarea aria-label="draft" value={draft} onChange={e=>setDraft(e.target.value)} /><button onClick={()=>void runtimeFetch('/api/projects',{method:'POST',body:JSON.stringify({draft})}).then(()=>setSent(true))}>发送</button>{sent&&<p>已发送</p>}</>;
}
import * as React from 'react';
createRoot(document.getElementById('root')).render(<PersonalResearchGate accountUrl="http://pool.test"><Workspace /></PersonalResearchGate>);`,
    loader: "tsx",
    resolveDir: new URL("../ui/", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const macChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.ORX_BROWSER_EXECUTABLE ||
  (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.clock.install();
  let state = "waiting",
    posts = 0;
  await page.route(
    "http://pool.test/api/platform/personal-space",
    async (route) => {
      if (route.request().method() === "POST") {
        posts++;
        if (state === "sleeping") state = "ready";
      }
      await route.fulfill({
        json: { id: "private-space", status: state, online: state === "ready" },
      });
    },
  );
  await page.route("http://pool.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto("http://pool.test/");
  await page.addScriptTag({ content: result.outputFiles[0].text });
  // The workspace is usable before compute is available.
  await page.getByRole("textbox").waitFor();
  assert.equal(await page.getByRole("heading").count(), 0);
  await page.getByRole("textbox").fill("未发送的研究草稿");
  let executed = 0, requests = 0;
  await page.route("http://pool.test/api/projects", async route => {
    requests++;
    if (state !== "ready") return route.fulfill({ status: 503, headers: { "x-orx-runtime-pending": "1" }, json: {} });
    executed++;
    assert.equal(JSON.parse(route.request().postData()).draft, "未发送的研究草稿");
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await new Promise(r => setTimeout(r, 100));
  assert(requests > 0);
  assert.equal(executed, 0);
  state = "ready";
  await page.clock.runFor(1600);
  await page.getByText("已发送", { exact: true }).waitFor();
  assert.equal(executed, 1);
  for (let i = 0; i < 7; i++) {
    await page.clock.runFor(10000);
    await new Promise(r => setTimeout(r, 30));
  }
  state = "sleeping";
  const before = posts;
  await page.clock.runFor(20050);
  assert.equal(posts, before, "background tabs and polling must not acquire compute");
  assert.equal(await page.getByRole("textbox").isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "继续研究" }).count(), 0);
  await page.getByRole("textbox").press("End");
  await new Promise(r => setTimeout(r, 100));
  assert(posts > before, "returning interaction must resume compute automatically");
  assert.equal(state, "ready");
  assert.equal(await page.getByRole("textbox").inputValue(), "未发送的研究草稿");
  await page.screenshot({ path: join(tmpdir(), "mobilesci-pool-browser.png") });
  console.log(
    JSON.stringify({
      workspaceVisibleBeforeReady: true,
      operationExecutedOnce: true,
      automaticAdmission: true,
      automaticRecovery: true,
      draftPreserved: true,
    }),
  );
  // Exercise the built application's actual homepage with compute unavailable.
  const home = await browser.newPage();
  const errors = [];
  home.on("pageerror", error => errors.push(error.message));
  await home.route("http://workspace.test/**", async route => {
    const url = new URL(route.request().url());
    const json = value => route.fulfill({ json: value });
    if (url.pathname === "/_orx/runtime") return json({ kind: "local", version: "test", accountUrl: "http://workspace.test" });
    if (url.pathname === "/api/platform/catalog-session") return json({ user: { id: "test-user", name: "Test", email: "test@example.invalid" }, canAccessResearch: true, privateResearch: true, deepLiteratureUrl: null });
    if (url.pathname === "/api/platform/personal-space") return json({ id: "test-space", status: "waiting", online: false });
    if (url.pathname === "/api/events") return;
    if (url.pathname.startsWith("/api/platform/")) return json({ cases: [] });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 503, headers: { "x-orx-runtime-pending": "1" }, json: {} });
    const asset = url.pathname.startsWith("/assets/") || url.pathname.startsWith("/pdfjs/");
    const file = new URL(`../ui/dist/${asset ? url.pathname.slice(1) : "index.html"}`, import.meta.url);
    const ext = file.pathname.split(".").pop();
    const types = { js: "text/javascript", css: "text/css", html: "text/html", svg: "image/svg+xml", png: "image/png", webp: "image/webp", woff2: "font/woff2" };
    return route.fulfill({ contentType: types[ext] || "application/octet-stream", body: await readFile(file) });
  });
  await home.goto("http://workspace.test/projects", { waitUntil: "domcontentloaded" });
  const composer = home.locator("#research-objective");
  await composer.waitFor();
  await composer.fill("环境尚未启动时也能输入的研究目标");
  for (const width of [1440, 900, 650]) {
    await home.setViewportSize({ width, height: 900 });
    assert.equal(await composer.isVisible(), true);
    assert.equal(await composer.inputValue(), "环境尚未启动时也能输入的研究目标");
    assert.equal(await home.getByRole("button", { name: "继续研究", exact: true }).count(), 0);
    assert(!/你的研究空间已休息|正在准备你的个人研究环境|正在连接你的个人研究环境|正在等待计算资源|先浏览公共精选案例/.test(await home.locator("body").innerText()));
    const box = await composer.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1, "composer stays inside the viewport");
    await home.screenshot({ path: join(tmpdir(), `mobilesci-background-runtime-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  await home.close();
  console.log(JSON.stringify({ builtHomeBeforeReady: true, wide: true, narrow: true, collapsedMobileSidebar: true, draftPreserved: true }));

} finally {
  await browser.close();
}
