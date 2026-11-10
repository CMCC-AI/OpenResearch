#!/usr/bin/env node
// Actual account-page UI against a synthetic API. Accounting/auth use real PostgreSQL integration tests.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const require = createRequire(new URL("ui/package.json", root));
const { chromium } = require("@playwright/test");
const files = new Set(["platform.js", "platform.css", "brand.svg"]);
const assets = new URL("packages/platform/public/", root);
const artifacts = new URL("ui/test-results/token-quota/", root);
await mkdir(artifacts, { recursive: true });
let monthlyLimit = 2000000;
const writes = [],
  errors = [];
let origin;
const balance = () => ({
  enabled: true,
  period: "2026-11",
  timezone: "Asia/Shanghai",
  monthlyLimit,
  granted: monthlyLimit,
  used: 100,
  reserved: 0,
  available: monthlyLimit - 100,
});
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    const admin = req.headers.cookie?.includes("quota-role=admin");
    const send = (v) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/api/platform/me")
      return send({
        name: admin ? "Admin" : "Researcher",
        email: admin ? "admin@example.com" : "user@example.com",
        isAdmin: admin,
      });
    if (url.pathname === "/api/platform/capabilities")
      return send({ openResearchAppUrl: origin + "/projects" });
    if (url.pathname === "/api/platform/token-quota") return send(balance());
    if (url.pathname === "/api/platform/admin/token-quotas" && admin) {
      if (req.method === "POST") {
        let text = "";
        for await (const chunk of req) text += chunk;
        const data = JSON.parse(text);
        assert.equal(data.email, "user@example.com");
        assert.equal(data.monthlyLimit, 3000000);
        assert.match(data.idempotencyKey, /^[0-9a-f-]{36}$/);
        writes.push(data);
        monthlyLimit = data.monthlyLimit;
      }
      return send({
        ...balance(),
        user: { name: "<target>", email: "user@example.com" },
        requests: [],
      });
    }
    if (url.pathname === "/_account/login") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await readFile(new URL("index.html", assets)));
      return;
    }
    if (files.has(url.pathname.slice(1))) {
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : "image/svg+xml",
      });
      res.end(await readFile(new URL(url.pathname.slice(1), assets)));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    errors.push(req.method + " " + url.pathname);
    res.writeHead(404);
    res.end();
  } catch (error) {
    errors.push(error.message);
    res.writeHead(500);
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.TOKEN_QUOTA_TEST_CHROMIUM || undefined,
  });
  const admin = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await admin.addCookies([{ name: "quota-role", value: "admin", url: origin }]);
  const page = await admin.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/_account/login?account=1");
  await page.getByRole("button", { name: "Token 额度", exact: true }).click();
  await page.getByLabel("用户邮箱").fill("user@example.com");
  await page.getByRole("button", { name: "查询用户", exact: true }).click();
  await page.getByLabel("每月 token 额度").fill("3000000");
  await page.getByLabel("调整原因").fill("browser acceptance");
  await page.getByRole("button", { name: "保存月额度", exact: true }).click();
  await page
    .locator("#quota-user-result")
    .getByText("3,000,000", { exact: true })
    .first()
    .waitFor();
  assert.equal(writes.length, 1);
  assert.match(
    await page.locator("#quota-user-result").textContent(),
    /<target>/,
  );
  await page.screenshot({
    path: fileURLToPath(new URL("admin-wide.png", artifacts)),
    fullPage: true,
  });
  const user = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await user.addCookies([{ name: "quota-role", value: "user", url: origin }]);
  const narrow = await user.newPage();
  narrow.on("pageerror", (e) => errors.push(e.message));
  await narrow.goto(origin + "/_account/login?account=1");
  await narrow.getByRole("button", { name: "Token 额度", exact: true }).click();
  await narrow.getByText("3,000,000", { exact: true }).first().waitFor();
  assert.equal(await narrow.locator("#quota-user").count(), 0);
  assert.ok(
    await narrow.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "narrow page must not overflow horizontally",
  );
  assert.ok(
    await narrow
      .locator("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
    "narrow dialog must not overflow horizontally",
  );
  await narrow.screenshot({
    path: fileURLToPath(new URL("user-narrow.png", artifacts)),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("proof.json", artifacts),
    JSON.stringify(
      {
        adminMonthlyLimit: monthlyLimit,
        adminWrites: writes.length,
        narrowWidth: 390,
        ordinaryUserAdminControls: 0,
        realModelsInvoked: false,
        api: "synthetic",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Token quota account browser acceptance passed: admin configuration and ordinary-user narrow display",
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
