import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const file = ts.createSourceFile("ResearchPauseControl.tsx", readFileSync(new URL("../src/components/ResearchPauseControl.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = file.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(file).replace(/^export /, "")).join("\n");
const code = ts.transpileModule(`${declarations}\nexports.Control = ResearchPauseControl;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function load({ status = "active", readOnly = false, failure = null } = {}) {
  const buttons = [], calls = [], errors = [], invalidations = [];
  const study = { id: "study", sessionId: "lead", mode: "team", status, plans: [{ version: 7, tasks: [] }], decisions: [], claims: [] };
  const bindings = {
    require,
    useState: initial => {
      const slot = { value: initial };
      const set = value => { slot.value = typeof value === "function" ? value(slot.value) : value; if (typeof value === "string") errors.push(value); };
      return [slot.value, set];
    },
    Pause: () => null,
    Play: () => null,
    pauseResearchStudy: async (...args) => { calls.push(["pause", ...args]); if (failure) throw new Error(failure); },
    resumeResearchStudy: async (...args) => { calls.push(["resume", ...args]); if (failure) throw new Error(failure); },
    queryClient: { invalidateQueries: options => invalidations.push(options) },
    workspaceKey: (...values) => values,
    IconButton: ({ children, ...props }) => { buttons.push({ ...props, children }); return React.createElement("button", props, children); },
    Spinner: () => null,
    useReadOnlyWorkspace: () => readOnly,
  };
  const exports = {};
  new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
  return { study, buttons, calls, errors, invalidations, exports };
}

test("active studies offer pause; paused studies offer resume; other states offer nothing", async () => {
  const app = load();
  const htmlActive = renderToStaticMarkup(React.createElement(app.exports.Control, { study: app.study }));
  assert.match(htmlActive, /aria-label="暂停研究"/);
  app.buttons.find(button => button["aria-label"] === "暂停研究").onClick();
  await new Promise(setImmediate);
  assert.deepEqual(app.calls, [["pause", "study", 7]]);

  const resumed = load({ status: "paused" });
  const htmlPaused = renderToStaticMarkup(React.createElement(resumed.exports.Control, { study: resumed.study }));
  assert.match(htmlPaused, /aria-label="继续研究"/);
  resumed.buttons.find(button => button["aria-label"] === "继续研究").onClick();
  await new Promise(setImmediate);
  assert.deepEqual(resumed.calls, [["resume", "study", 7]]);

  for (const options of [{ status: "stopped" }, { readOnly: true }]) {
    const app = load(options);
    const markup = renderToStaticMarkup(React.createElement(app.exports.Control, { study: app.study }));
    assert.ok(!markup.includes("暂停研究"));
    assert.ok(!markup.includes("继续研究"));
  }
});

test("pause and resume refresh the study query on success", async () => {
  for (const status of ["active", "paused"]) {
    const app = load({ status });
    renderToStaticMarkup(React.createElement(app.exports.Control, { study: app.study }));
    app.buttons.find(button => button.onClick)?.onClick();
    await new Promise(setImmediate);
    assert.deepEqual(app.invalidations, [{ queryKey: ["researchStudy", "lead"] }]);
    assert.deepEqual(app.errors, []);
  }
});

test("failures surface without invalidating the study query", async () => {
  const app = load({ failure: "研究计划已变化，请刷新后再操作" });
  renderToStaticMarkup(React.createElement(app.exports.Control, { study: app.study }));
  app.buttons.find(button => button["aria-label"] === "暂停研究").onClick();
  await new Promise(setImmediate);
  assert.deepEqual(app.calls, [["pause", "study", 7]]);
  assert.deepEqual(app.errors, ["研究计划已变化，请刷新后再操作"]);
  assert.deepEqual(app.invalidations, []);
});
