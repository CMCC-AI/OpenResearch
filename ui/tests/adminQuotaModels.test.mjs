import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadCatalog() {
  const code = ts.transpileModule(
    readFileSync(new URL("../src/product/quotaProviderCatalog.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  new Function("require", "exports", code)(require, exports);
  return exports;
}

function renderAdminQuotaModels(settings) {
  const catalogExports = loadCatalog();
  const code = ts.transpileModule(
    readFileSync(new URL("../src/product/AdminQuotaModels.tsx", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } },
  ).outputText;
  const exports = {};
  const mocks = {
    "lucide-react": new Proxy({}, {
      get: (_, name) => (props) => React.createElement("svg", { "data-icon": String(name), ...props }),
    }),
    "../components/ui": {
      Badge: ({ children }) => React.createElement("span", { "data-badge": "1" }, children),
      Button: ({ children, ...props }) => React.createElement("button", props, children),
      Input: (props) => React.createElement("input", props),
      Switch: ({ checked, ...props }) =>
        React.createElement("button", { role: "switch", "aria-checked": checked, ...props }),
    },
    "./featuredCasesApi": {
      caseWrite: async () => settings,
    },
    "./quotaProviderCatalog": catalogExports,
  };
  new Function("require", "exports", code)((id) => (id in mocks ? mocks[id] : require(id)), exports);
  return renderToStaticMarkup(React.createElement(exports.AdminQuotaModels, { settings, base: "/mobilesci" }));
}

test("resolveConnectedProviders merges saved, catalog, and discovered models per provider", () => {
  const { resolveConnectedProviders, buildModelAlias } = loadCatalog();
  const settings = {
    enabled: true,
    backend: "quota",
    revision: "rev-1",
    providers: [
      {
        id: "custom-gw",
        name: "Custom Gateway",
        baseUrl: "https://gw.example.com/v1",
        hasApiKey: true,
        discoveredModels: ["qwen-custom-72b"],
      },
    ],
    models: [
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        providerId: "moonshotai-cn",
        providerName: "Kimi / Moonshot",
        model: "kimi-k2.6",
        baseUrl: "https://api.moonshot.cn/v1",
        contextTokens: 131072,
        maxOutputTokens: 8192,
        hasApiKey: true,
      },
    ],
  };

  const resolved = resolveConnectedProviders(settings, {});
  assert.equal(resolved.length, 2);

  const moonshot = resolved.find((p) => p.id === "moonshotai-cn");
  assert.ok(moonshot);
  assert.equal(moonshot.enabledCount, 1);
  assert.ok(moonshot.models.some((m) => m.model === "kimi-k2.6" && m.enabled && m.isDefault));
  assert.ok(moonshot.models.some((m) => m.model === "kimi-k3" && !m.enabled && m.source === "catalog" && !m.needsLimitConfirmation));

  const custom = resolved.find((p) => p.id === "custom-gw");
  assert.ok(custom);
  const discovered = custom.models.find((m) => m.model === "qwen-custom-72b");
  assert.ok(discovered);
  assert.equal(discovered.enabled, false);
  assert.equal(discovered.needsLimitConfirmation, true);

  assert.equal(buildModelAlias("moonshotai-cn", "kimi-k2.6", settings.models), "kimi-k2.6");
  assert.equal(buildModelAlias("deepseek", "kimi-k2.6", settings.models), "deepseek:kimi-k2.6");
});

test("AdminQuotaModels renders OpenCode-style provider/model tabs and switch toggles", () => {
  const html = renderAdminQuotaModels({
    enabled: true,
    backend: "quota",
    revision: "rev-1",
    models: [
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        providerId: "moonshotai-cn",
        providerName: "Kimi / Moonshot",
        model: "kimi-k2.6",
        baseUrl: "https://api.moonshot.cn/v1",
        contextTokens: 131072,
        maxOutputTokens: 8192,
        hasApiKey: true,
      },
    ],
  });

  assert.match(html, /role="tab"[^>]*>提供商</);
  assert.match(html, /role="tab"[^>]*>模型</);
  assert.match(html, /Kimi \/ Moonshot/);
  assert.match(html, /默认模型/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /aria-checked="false"/);
});
