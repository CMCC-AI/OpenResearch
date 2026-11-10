#!/usr/bin/env node
// Built workspace UI against synthetic accounts; no executor or model is started.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const require = createRequire(new URL("ui/package.json", root));
const { chromium } = require("@playwright/test");
const assets = new URL("ui/dist/", root);
const artifacts = new URL("ui/test-results/token-quota/", root);
await mkdir(artifacts, { recursive: true });
let monthlyLimit = 2000000,
  pending = true,
  origin;
const writes = [],
  reconciliations = [],
  errors = [],
  unexpected = [];
const balance = () => ({
  enabled: true,
  period: "2026-11",
  timezone: "Asia/Shanghai",
  monthlyLimit,
  granted: monthlyLimit,
  used: 100,
  reserved: pending ? 50 : 0,
  available: monthlyLimit - 100 - (pending ? 50 : 0),
});
const target = {
  id: "target-user",
  name: "<target>",
  email: "user@example.com",
  is_admin: false,
  disabled: false,
  created_at: "2026-11-01T00:00:00Z",
  last_login_at: null,
};
const managed = () => ({
  ...balance(),
  user: target,
  requests: pending
    ? [
        {
          id: "11111111-1111-4111-8111-111111111111",
          period: "2026-11",
          model: "research",
          state: "pending",
          reserved: 50,
          upstream_request_id: "synthetic-request",
        },
      ]
    : [],
});
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    const path = url.pathname.replace(/^\/mobilesci(?=\/)/, "");
    const admin = req.headers.cookie?.includes("quota-role=admin");
    const send = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const user = {
      id: admin ? "admin" : "reader",
      name: admin ? "Admin" : "Researcher",
      email: admin ? "admin@example.com" : "user@example.com",
      isAdmin: !!admin,
    };
    if (path === "/_orx/runtime")
      return send({ kind: "local", version: "test", accountUrl: origin });
    if (path === "/api/platform/catalog-session")
      return send({
        user,
        canAccessResearch: true,
        privateResearch: true,
        deepLiteratureUrl: null,
      });
    if (path === "/api/platform/token-quota") return send(balance());
    if (path === "/api/platform/admin/users" && admin)
      return send({
        summary: { total: 1, enabled: 1, disabled: 0, admins: 0 },
        users: [target],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    if (path.startsWith("/api/platform/admin/token-quotas") && admin) {
      if (req.method === "POST") {
        let body = "";
        for await (const part of req) body += part;
        const data = JSON.parse(body);
        assert.equal(data.email, "user@example.com");
        if (path.endsWith("/reconcile")) {
          assert.equal(data.actualTokens, 12);
          reconciliations.push(data);
          pending = false;
        } else {
          assert.equal(data.monthlyLimit, 3000000);
          assert.match(data.idempotencyKey, /^[0-9a-f-]{36}$/);
          writes.push(data);
          monthlyLimit = data.monthlyLimit;
        }
      }
      return send(managed());
    }
    if (path === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (path.startsWith("/api/") || path.startsWith("/_platform/")) {
      unexpected.push(req.method + " " + path);
      return send({ error: "unexpected executor/account request" }, 503);
    }
    const relative = path.startsWith("/assets/")
      ? path.slice(1)
      : path === "/favicon.svg"
        ? "favicon.svg"
        : "index.html";
    const contents = await readFile(new URL(relative, assets));
    res.writeHead(200, {
      "content-type": relative.endsWith(".js")
        ? "text/javascript"
        : relative.endsWith(".css")
          ? "text/css"
          : relative.endsWith(".svg")
            ? "image/svg+xml"
            : relative.endsWith(".png")
              ? "image/png"
              : "text/html",
    });
    res.end(contents);
  } catch (e) {
    errors.push(e.message);
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  await admin.addInitScript(() =>
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    }),
  );
  const page = await admin.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/mobilesci/admin/users");
  await page
    .getByRole("row")
    .filter({ hasText: "user@example.com" })
    .getByRole("link", { name: "Token 额度", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "用户 Token 额度", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("用户邮箱").inputValue(),
    "user@example.com",
  );
  await page.getByLabel("每月 Token 额度").fill("3000000");
  await page.getByLabel("调整原因").fill("browser acceptance");
  await page.getByRole("button", { name: "保存月额度", exact: true }).click();
  await page
    .getByText("月额度已保存，本月已用和在途消费保留。", { exact: true })
    .waitFor();
  assert.equal(writes.length, 1);
  assert.ok(
    (
      await page
        .getByRole("heading", {
          name: "<target> · user@example.com",
          exact: true,
        })
        .textContent()
    ).includes("<target>"),
  );
  await page.getByLabel("实际 Token 用量").fill("12");
  await page.getByLabel("补账依据").fill("synthetic provider receipt");
  await page.getByRole("button", { name: "确认并补账", exact: true }).click();
  await page.getByText("暂无待确认请求", { exact: true }).waitFor();
  assert.equal(reconciliations.length, 1);
  await page.locator("main").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: fileURLToPath(new URL("admin-wide.png", artifacts)),
    fullPage: true,
  });
  const adminNarrowContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await adminNarrowContext.addCookies([
    { name: "quota-role", value: "admin", url: origin },
  ]);
  const adminNarrow = await adminNarrowContext.newPage();
  await adminNarrow.goto(
    origin + "/mobilesci/admin/quotas?email=user%40example.com",
  );
  await adminNarrow.getByLabel("每月 Token 额度").waitFor();
  assert.ok(
    await adminNarrow.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await adminNarrow.screenshot({
    path: fileURLToPath(new URL("admin-narrow.png", artifacts)),
    fullPage: true,
  });
  const normal = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await normal.addCookies([{ name: "quota-role", value: "user", url: origin }]);
  let user = await normal.newPage();
  user.on("pageerror", (e) => errors.push(e.message));
  await user.goto(origin + "/mobilesci/settings/account");
  await user.getByRole("heading", { name: "账户资料", exact: true }).waitFor();
  await user
    .getByRole("button", { name: "个人用户菜单 · Researcher", exact: true })
    .click();
  await user.getByRole("menuitem").filter({ hasText: "Token 额度" }).click();
  await user
    .getByRole("heading", { name: "我的 Token 额度", exact: true })
    .waitFor();
  await user.getByText("3,000,000", { exact: true }).waitFor();
  assert.equal(await user.getByLabel("用户邮箱").count(), 0);
  await user.screenshot({
    path: fileURLToPath(new URL("user-wide.png", artifacts)),
    fullPage: true,
  });
  const narrowContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await narrowContext.addCookies([
    { name: "quota-role", value: "user", url: origin },
  ]);
  user = await narrowContext.newPage();
  user.on("pageerror", (e) => errors.push(e.message));
  await user.goto(origin + "/mobilesci/settings/quota");
  await user.getByText("3,000,000", { exact: true }).waitFor();
  assert.equal(await user.locator(".product-frame").count(), 1);
  assert.ok(
    await user.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await user.screenshot({
    path: fileURLToPath(new URL("user-narrow.png", artifacts)),
    fullPage: true,
  });
  await user.getByRole("link", { name: "账户与安全", exact: true }).click();
  await user
    .getByLabel("当前密码", { exact: true })
    .fill("Current synthetic password");
  await user
    .getByLabel("新密码", { exact: true })
    .fill("New synthetic password");
  await user
    .getByLabel("确认新密码", { exact: true })
    .fill("Different synthetic password");
  await user
    .getByRole("button", { name: "保存并重新登录", exact: true })
    .click();
  await user
    .getByRole("alert")
    .filter({ hasText: "两次输入的新密码不一致" })
    .waitFor();
  await user.goto(origin + "/mobilesci/admin/quotas");
  await user
    .getByRole("heading", { name: "无权访问系统管理", exact: true })
    .waitFor();
  assert.deepEqual(
    unexpected,
    [],
    "account settings and administration must never wake an executor",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    new URL("proof.json", artifacts),
    JSON.stringify(
      {
        adminConfiguredMonthlyLimit: monthlyLimit,
        reconciliation: true,
        personalMenu: true,
        accountSettings: true,
        ordinaryAdminDenied: true,
        executorRequests: unexpected.length,
        wideAndNarrow: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Workspace token quota and personal settings browser acceptance passed",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
