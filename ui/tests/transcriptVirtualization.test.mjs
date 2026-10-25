import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { defaultRangeExtractor } from "@tanstack/react-virtual";

const file = ts.createSourceFile("ChatPanel.tsx", readFileSync(new URL("../src/components/ChatPanel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function visit(node) {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found);
  return found;
}
function evaluate(code, bindings) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

test("virtual history retains interacted rows outside the viewport and drops absent branch IDs", () => {
  const expression = find(node => ts.isVariableDeclaration(node) && node.name.getText(file) === "rangeExtractor").initializer;
  const retainedRows = { current: new Set(["a", "deleted"]) };
  const extract = evaluate(`return ${expression.getText(file)}`, {
    useCallback: callback => callback,
    visibleMessages: ["a", "b", "c", "d", "e"].map(id => ({ id })),
    retainedRows,
    fullHistory: false,
    defaultRangeExtractor,
  });
  assert.deepEqual(extract({ startIndex: 3, endIndex: 4, overscan: 0, count: 5 }), [0, 3, 4]);
  retainedRows.current.add("b");
  assert.deepEqual(extract({ startIndex: 4, endIndex: 4, overscan: 0, count: 5 }), [0, 1, 4]);
});

test("tool labels reuse immutable parts but refresh after stream replacement or locale change", () => {
  const declaration = find(node => ts.isFunctionDeclaration(node) && node.name?.text === "toolActivity");
  let locale = "en", calls = 0;
  const activity = evaluate(`const toolActivities = new WeakMap(); ${declaration.getText(file)}; return toolActivity;`, {
    getLocale: () => locale,
    computeToolActivity: part => { calls++; return { label: `${locale}:${part.state.status}` }; },
  });
  const original = { id: "tool-1", state: { status: "running" } };
  assert.strictEqual(activity(original), activity(original));
  assert.equal(calls, 1);
  assert.equal(activity({ ...original, state: { status: "completed" } }).label, "en:completed");
  locale = "es";
  assert.equal(activity(original).label, "es:running");
  assert.equal(calls, 3);
});

test("accessible full history includes every message", () => {
  const expression = find(node => ts.isVariableDeclaration(node) && node.name.getText(file) === "rangeExtractor").initializer;
  const extract = evaluate(`return ${expression.getText(file)}`, {
    useCallback: callback => callback,
    visibleMessages: ["a", "b", "c"].map(id => ({ id })),
    retainedRows: { current: new Set() }, fullHistory: true, defaultRangeExtractor,
  });
  assert.deepEqual(extract({ startIndex: 2, endIndex: 2, overscan: 0, count: 3 }), [0, 1, 2]);
});

test("viewport and footer resizing preserve bottom pin without moving a reader", () => {
  const effect = find(node => ts.isCallExpression(node) && node.expression.getText(file) === "useEffect" && node.getText(file).includes("observer.observe(inner)")).arguments[0];
  let resize, pinned = 0, updated = 0, disconnected = false;
  const observed = [], el = { scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }, inner = {}, stickToBottom = { current: true };
  const setup = evaluate(`return ${effect.getText(file)}`, {
    threadRef: { current: el }, threadInnerRef: { current: inner }, stickToBottom,
    scrollToEndRef: { current: () => { pinned++; } },
    setTranscriptAtBottom: value => { assert.equal(value, el.scrollHeight - el.scrollTop - el.clientHeight < 60); updated++; },
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe(target) { observed.push(target); }
      disconnect() { disconnected = true; }
    },
  });
  const cleanup = setup();
  assert.deepEqual(observed, [el, inner]);
  resize();
  assert.equal(pinned, 1);
  stickToBottom.current = false;
  resize();
  assert.equal(pinned, 1);
  assert.equal(updated, 1);
  assert.equal(stickToBottom.current, false);
  el.scrollHeight += 400;
  resize();
  assert.equal(pinned, 1);
  assert.equal(stickToBottom.current, false);
  cleanup();
  assert.equal(disconnected, true);
});

test("mounting a different conversation resets both bottom-pin representations", () => {
  const expression = find(node => ts.isVariableDeclaration(node) && node.name.getText(file) === "pinTranscriptToBottom").initializer;
  const effect = find(node => ts.isCallExpression(node) && node.expression.getText(file) === "useLayoutEffect" && node.getText(file).includes("onPinToBottom()")).arguments[0];
  const stickToBottom = { current: false }, scrollToEndRef = { current: null };
  let atBottom = false, scrolls = 0;
  const pin = evaluate(`return ${expression.getText(file)}`, {
    useCallback: callback => callback, stickToBottom, scrollToEndRef,
    setTranscriptAtBottom: value => { atBottom = value; },
  });
  const mount = evaluate(`return ${effect.getText(file)}`, {
    virtualizer: { scrollToEnd: () => { scrolls++; } }, scrollToEndRef, onPinToBottom: pin,
  });
  const cleanup = mount();
  assert.equal(stickToBottom.current, true);
  assert.equal(atBottom, true);
  assert.equal(scrolls, 1);
  cleanup();
  assert.equal(scrollToEndRef.current, null);
});

function measurementLifecycle({ messages, sizes, widths, retained = [], cache = new Map(), scope = "workspace-a" }) {
  const effect = find(node => ts.isCallExpression(node) && node.expression.getText(file) === "useLayoutEffect"
    && node.getText(file).includes("transcriptRowSizes.set")).arguments[0];
  const mount = evaluate(`return ${effect.getText(file)}`, {
    latestMessages: { current: messages }, virtualizer: { itemSizeCache: sizes },
    measuredWidths: { current: widths }, retainedRows: { current: new Set(retained) },
    transcriptRowSizes: cache, measurementScope: scope, TRANSCRIPT_ROW_SIZES_LIMIT: 5000,
  });
  mount()();
  const declaration = find(node => ts.isVariableDeclaration(node) && node.name.getText(file) === "[initialMeasurementsCache]");
  const seed = (width = 840, measurementScope = scope, visibleMessages = messages) => evaluate(
    `return (${declaration.initializer.arguments[0].getText(file)})();`, {
      visibleMessages, transcriptRowSizes: cache, measurementScope, scrollRef: { current: { offsetWidth: width } },
    });
  return { cache, seed };
}

test("chat remount reuses stable measured rows but rejects expanded, streaming and removed rows", () => {
  const messages = [
    { id: "user", role: "user" }, { id: "answer", role: "assistant", completedAt: 10 },
    { id: "expanded", role: "assistant", completedAt: 10 }, { id: "stream", role: "assistant" },
  ];
  const { cache, seed } = measurementLifecycle({ messages,
    sizes: new Map([["user", 120], ["answer", 780], ["expanded", 900], ["stream", 230], ["removed", 100]]),
    widths: new Map(messages.map(message => [message.id, 840])), retained: ["expanded"],
  });
  assert.deepEqual([...cache.keys()], ["user", "answer"]);
  assert.deepEqual(seed().map(row => [row.key, row.index, row.size]), [["user", 0, 120], ["answer", 1, 780]]);
  assert.deepEqual(seed(420), [], "a narrow panel must remeasure");
  assert.deepEqual(seed(840, "workspace-b"), [], "other workspaces cannot reuse heights");
  assert.deepEqual(seed(840, "workspace-a", [{ ...messages[1], completedAt: 20 }]), [], "changed completion invalidates old height");
});

test("measurement cache evicts oldest dimensions at its fixed limit", () => {
  const messages = Array.from({ length: 5002 }, (_, id) => ({ id: String(id), role: "user" }));
  const { cache } = measurementLifecycle({ messages,
    sizes: new Map(messages.map(message => [message.id, 100])),
    widths: new Map(messages.map(message => [message.id, 840])),
  });
  assert.equal(cache.size, 5000);
  assert.equal(cache.has("0"), false);
  assert.equal(cache.has("1"), false);
  assert.equal(cache.has("5001"), true);
  assert.deepEqual(Object.keys(cache.get("5001")).sort(), ["completedAt", "scope", "size", "width"]);
});

test("entry-less cached measurements do not adopt the width of an unmeasured resize", () => {
  const options = find(node => ts.isCallExpression(node) && node.expression.getText(file) === "useVirtualizer"
    && node.getText(file).includes("initialMeasurementsCache")).arguments[0];
  const measure = options.properties.find(property => property.name?.getText(file) === "measureElement").initializer;
  const measuredWidths = { current: new Map([["answer", 840]]) };
  const callback = evaluate(`return ${measure.getText(file)}`, {
    measuredWidths, measureVirtualElement: () => 100,
  });
  const element = { getAttribute: () => "answer" };
  const instance = { itemSizeCache: new Map([["answer", 100]]), scrollElement: { offsetWidth: 420 } };
  callback(element, undefined, instance);
  assert.equal(measuredWidths.current.get("answer"), 840);
  callback(element, {}, instance);
  assert.equal(measuredWidths.current.get("answer"), 420);
});
