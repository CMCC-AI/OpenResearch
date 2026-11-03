import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/MaterialCitationSource.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText + "\nexports.Selection = CitationSelection;";
const citation = { readEventId: "event", path: "资料/论文.txt", source: "SRC-0001", offset: 2, lineCount: 1, page: null, sha256: "source-hash", contentSha256: "selection-hash", packageId: "package", readerSessionId: null };
function setup() {
  const state = [], effects = [], pending = [], calls = [];
  let cursor = 0, effectCursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === "function" ? value(state[i]) : value; }]; },
    useId: () => "selection-id",
    useRef: initial => hooks.useState({ current: initial })[0],
    useEffect(run, deps) { const i = effectCursor++; if (!effects[i] || deps.some((d, n) => !Object.is(d, effects[i].deps[n]))) pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: run() }; }); },
  };
  const loadMaterialCitation = (value, signal) => new Promise((resolve, reject) => calls.push({ value, signal, resolve, reject }));
  const exported = {};
  const mocks = { react: hooks, "../materialCitation": { loadMaterialCitation, citationRange: value => `第 ${value.offset} 行` }, "./ui": { Button: "button", Spinner: "span" } };
  new Function("require", "exports", code)(id => mocks[id] ?? require(id), exported);
  return {
    calls,
    render(value = citation, component = "Selection") { cursor = 0; effectCursor = 0; return exported[component]({ citation: value }); },
    flush() { pending.splice(0).forEach(run => run()); },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}
const tick = () => new Promise(setImmediate);
function nodes(tree) { if (!tree || typeof tree !== "object") return []; return [tree, ...[tree.props?.children].flat().flatMap(nodes)]; }

test("opening and closing a source is explicit and has accessible expanded/region state", () => {
  const app = setup();
  const closed = app.render(citation, "MaterialCitationSource");
  const button = nodes(closed).find(n => n.type === "button");
  assert.equal(button.props["aria-expanded"], false);
  assert.equal(app.calls.length, 0);
  button.props.onClick();
  const opened = app.render(citation, "MaterialCitationSource");
  assert.equal(nodes(opened).find(n => n.type === "button").props["aria-expanded"], true);
  assert.equal(nodes(opened).find(n => n.props?.role === "region").props.id, "selection-id");
});

test("equivalent polling data does not repeat extraction and source changes hide stale results", async () => {
  const app = setup();
  assert.match(renderToStaticMarkup(app.render()), /正在核验/); app.flush();
  app.calls[0].resolve("2: <script>data</script>\n"); await tick();
  const html = renderToStaticMarkup(app.render({ ...citation })); app.flush();
  assert.equal(app.calls.length, 1); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  const changed = { ...citation, readEventId: "new-event", path: "资料/新论文.txt" };
  const beforeEffects = renderToStaticMarkup(app.render(changed));
  assert.doesNotMatch(beforeEffects, /data&lt;/); assert.match(beforeEffects, /正在核验/);
  app.flush(); assert.equal(app.calls[0].signal.aborted, true); assert.equal(app.calls.length, 2);
  app.unmount(); assert.equal(app.calls[1].signal.aborted, true);
});

test("late failures stay out of the next source and retry runs a fresh verification", async () => {
  const app = setup(); app.render(); app.flush();
  const next = { ...citation, readEventId: "next" };
  app.render(next); app.flush();
  app.calls[0].reject(new Error("old error")); await tick();
  assert.doesNotMatch(renderToStaticMarkup(app.render(next)), /old error/);
  app.calls[1].reject(new Error("原件已变化")); await tick();
  const tree = app.render(next); app.flush(); assert.match(renderToStaticMarkup(tree), /原件已变化/);
  nodes(tree).find(n => n.type === "button" && n.props.children === "重新核验").props.onClick();
  assert.match(renderToStaticMarkup(app.render(next)), /正在核验/); app.flush(); assert.equal(app.calls.length, 3);
  app.calls[2].resolve("2: recovered\n"); await tick();
  const recovered = app.render(next); const pre = nodes(recovered).find(n => n.type === "pre");
  let focused = false; pre.props.ref.current = { focus() { focused = true; } };
  const previous = globalThis.document; const body = {};
  globalThis.document = { body, activeElement: body };
  try { app.flush(); assert.equal(focused, true); } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }

});

test("retry completion does not take focus away from another control", async () => {
  const app = setup(); app.render(); app.flush();
  app.calls[0].reject(new Error("temporary failure")); await tick();
  const error = app.render(); app.flush();
  nodes(error).find(n => n.type === "button" && n.props.children === "重新核验").props.onClick();
  app.render(); app.flush();
  app.calls[1].resolve("2: recovered\n"); await tick();
  const ready = app.render(); const pre = nodes(ready).find(n => n.type === "pre");
  let focused = false; pre.props.ref.current = { focus() { focused = true; } };
  const previous = globalThis.document; globalThis.document = { body: {}, activeElement: { id: "another-control" } };
  try { app.flush(); assert.equal(focused, false); } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
