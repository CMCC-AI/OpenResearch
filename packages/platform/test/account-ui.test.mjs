import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const source = (
  await readFile(new URL("../public/platform.js", import.meta.url), "utf8")
).split("(resetToken ? Promise.resolve(recovery(")[0];
function browser(routes = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: "",
        textContent: "",
        disabled: false,
        classList: { add() {}, remove() {} },
        querySelector: () => node("submit"),
        setAttribute(name, value) {
          this[name] = value;
        },
      });
    return nodes.get(id);
  };
  const events = {},
    redirects = [],
    calls = [];
  const context = vm.createContext({
    URL,
    URLSearchParams,
    AbortSignal,
    setTimeout,
    clearTimeout,
    FormData: class {
      constructor(form) {
        return Object.entries(form.fields);
      }
    },
    window: { addEventListener() {} },
    document: {
      querySelector: node,
      getElementById: node,
      body: { classList: { add() {}, remove() {} } },
      addEventListener: (name, fn) => {
        events[name] = fn;
      },
    },
    history: { replaceState() {} },
    location: {
      hash: "",
      search: "",
      pathname: "/",
      replace: (url) => redirects.push(url),
      assign: (url) => redirects.push(url),
    },
    fetch: async (path, options) => {
      calls.push(path);
      const value = routes[path] || {};
      return {
        ok: true,
        status: 200,
        json: async () =>
          typeof value === "function" ? value(options) : value,
      };
    },
  });
  vm.runInContext(
    source +
      "\nglobalThis.ui = { authentication, recovery, load, passwordField };",
    context,
  );
  return { context, ui: context.ui, node, events, redirects, calls };
}
test("registration enters the app directly even when literature is configured", async () => {
  const b = browser({
    "/api/platform/me": {
      name: "Researcher",
      email: "test@test.invalid",
      isAdmin: false,
    },
    "/api/platform/capabilities": {
      privateSpaces: false,
      deepLiteratureUrl: "http://unavailable.test",
      openResearchAppUrl: "http://localhost:4791/projects",
    },
  });
  b.ui.authentication("register");
  const form = b.node("#auth-form");
  form.fields = {
    name: "Researcher",
    email: "test@test.invalid",
    password: "test password fixture",
  };
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.deepEqual(b.redirects, ["http://localhost:4791/projects"]);
  assert.ok(b.calls.includes("/api/platform/register"));
  assert.equal(b.node("submit").disabled, false);
});
test("password visibility toggles locally without changing or submitting the password", () => {
  const b = browser();
  const input = b.node("password-password");
  input.type = "password";
  input.value = "test-only fixture";
  const button = b.node("toggle");
  button.dataset = { passwordToggle: "password-password" };
  const event = { target: { closest: () => button } };
  b.events.click(event);
  assert.equal(input.type, "text");
  assert.equal(input.value, "test-only fixture");
  assert.equal(button["aria-pressed"], "true");
  b.events.click(event);
  assert.equal(input.type, "password");
  assert.equal(button["aria-pressed"], "false");
  assert.deepEqual(b.calls, []);
});
test("administrator lands on user management and normal users have no management link", async () => {
  const b = browser({
    "/api/platform/me": {
      name: "Admin",
      email: "admin@test.invalid",
      isAdmin: true,
    },
    "/api/platform/capabilities": {
      openResearchAppUrl: "http://localhost:4791/mobilesci/projects",
    },
  });
  await b.ui.load();
  assert.deepEqual(b.redirects, [
    "http://localhost:4791/mobilesci/admin/users",
  ]);
  assert.ok(
    !b.calls.some((path) => path.startsWith("/api/platform/admin/users")),
  );
  const ordinary = browser({
    "/api/platform/me": { name: "Reader", isAdmin: false },
  });
  ordinary.context.location.search = "?admin=1";
  await ordinary.ui.load();
  assert.match(ordinary.node("#app").innerHTML, /仅对系统管理员开放/);
  assert.deepEqual(ordinary.redirects, []);
});

test("account management links use canonical admin routes for root and prefixed apps", async () => {
  for (const prefix of ["", "/mobilesci"]) {
    const b = browser({
      "/api/platform/me": { name: "Admin", isAdmin: true },
      "/api/platform/capabilities": {
        openResearchAppUrl: `http://localhost:4791${prefix}/projects?from=old#section`,
      },
    });
    b.context.location.search = "?account=1";
    await b.ui.load();
    assert.ok(
      b
        .node("#account")
        .innerHTML.includes(
          `href="http://localhost:4791${prefix}/admin/users"`,
        ),
    );
    assert.ok(!b.node("#account").innerHTML.includes("admin=1"));
    assert.deepEqual(b.redirects, []);
    assert.equal(
      b.calls.filter((path) => path === "/api/platform/capabilities").length,
      1,
    );
  }
});
