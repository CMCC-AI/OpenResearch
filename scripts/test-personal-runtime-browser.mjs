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
      .replace(
        "export function PersonalResearchGate",
        "function PersonalResearchGate",
      )
      .replace(/import \{ Link \}[^\n]+\n/, "")
      .replace(/import \{ Button, Spinner \}[^\n]+\n/, "")}
import {createRoot} from 'react-dom/client';
const Link=({children,...props})=><a {...props}>{children}</a>;
const Button=({children,...props})=><button {...props}>{children}</button>;
const Spinner=()=> <span>Loading</span>;
createRoot(document.getElementById('root')).render(<PersonalResearchGate accountUrl="http://pool.test"><textarea aria-label="draft" /></PersonalResearchGate>);`,
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
  await page
    .getByRole("status")
    .filter({ hasText: "正在等待计算资源" })
    .waitFor();
  state = "ready";
  await page.clock.runFor(1600);
  await page.getByRole("textbox").waitFor();
  await page.getByRole("textbox").fill("未发送的研究草稿");
  for (let i = 0; i < 7; i++) {
    await page.clock.runFor(10000);
    await new Promise((r) => setTimeout(r, 100));
  }
  state = "sleeping";
  await page.clock.runFor(11000);
  await new Promise((r) => setTimeout(r, 100));

  await page.getByRole("button", { name: "继续研究" }).waitFor();
  const before = posts;
  await page.clock.runFor(20050);
  assert.equal(posts, before, "sleep polling must not reacquire compute");
  await page.getByRole("button", { name: "继续研究" }).click();
  await page.getByRole("textbox").waitFor();
  assert.equal(
    await page.getByRole("textbox").inputValue(),
    "未发送的研究草稿",
  );
  await page.screenshot({ path: join(tmpdir(), "mobilesci-pool-browser.png") });
  console.log(
    JSON.stringify({
      waiting: true,
      automaticAdmission: true,
      sleep: true,
      explicitWake: true,
      draftPreserved: true,
    }),
  );
} finally {
  await browser.close();
}
