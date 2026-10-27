import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = (path) => ts.createSourceFile(path, readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function evaluate(code, bindings) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
function find(file, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return matches;
}

const form = source("components/NewProjectForm.tsx");
const component = find(form, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "NewProjectForm")[0];
const statements = component.body.statements;
const firstState = statements.findIndex((node) => node.getText(form).includes("useState<"));
const selection = statements.slice(0, firstState).map((node) => node.getText(form)).join("\n");
const submit = find(form, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "submit")[0];
const picker = source("components/ModelPicker.tsx");
const fallback = find(picker, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "defaultSelection")[0];
const defaultSelection = evaluate(`return ${fallback.getText(picker).replace("export ", "")}`, {
  reconcileServiceTier: () => null,
  reasoningFor: () => ({ defaultId: null }),
});

test("blank project creation uses the current agent selection", async () => {
  const created = [];
  const harnesses = [{ id: "codex", agentReady: true, models: [{ id: "other-default" }] }, { id: "opencode", agentReady: true, models: [{ id: "catalog-default" }] }];
  const bindings = {
    useQuery: () => ({ data: harnesses }), getHarnessesQuery: () => ({}), defaultSelection,
    queryClient: { fetchQuery: async () => ({ exists: false }) },
    getProjectPathStatusQuery: () => ({}), getLocale: () => "en",
    createMutation: { mutateAsync: async (request) => { created.push(request); return { project: {}, githubPublicationError: null }; } },
    canCreate: true, projectPath: "/project", name: "Project", githubSyncEnabled: false,
    setPending: () => {}, setError: (error) => { assert.equal(error, null); }, onCreated: () => {},
  };
  const render = (preferredAgent) => evaluate(`${selection}\n${submit.getText(form)}\nreturn submit;`, { ...bindings, preferredAgent });
  for (const expected of [{ harness: "opencode", model: "my-provider/custom-model" }, { harness: "opencode", model: null }, { harness: "claude-code", model: null }, null]) {
    await render(expected)({ preventDefault() {} });
    const agent = expected?.harness === "opencode" ? expected : { harness: "opencode", model: "catalog-default" };
    assert.deepEqual(created.at(-1).starterAgent, agent);
    assert.equal(created.at(-1).creationMode, "blank");
    assert.equal(created.at(-1).requireNewFolder, true);
    assert.equal(created.at(-1).createFolder, true);
    assert.equal(created.at(-1).paperId, undefined);
    assert.equal(created.at(-1).cloneUrl, undefined);
  }
});

test("project entry points pass their current preference through to the form", () => {
  const current = { harness: "opencode", model: "my-provider/current" };
  const stale = { harness: "codex", model: "saved-model" };
  for (const [path, tag, bindings] of [
    ["components/ProjectsHome.tsx", "NewProjectDialog", { preferredAgent: current }],
    ["routePages.tsx", "ProjectsHome", { state: { preferredAgent: current } }],
    ["components/ProjectsHome.tsx", "NewProjectForm", { preferredAgent: current }],
  ]) {
    const file = source(path);
    const elements = find(file, (node) => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(file) === tag);
    assert.ok(elements.length, `${path}: ${tag}`);
    for (const element of elements) {
      const prop = element.attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.getText(file) === "preferredAgent");
      assert.ok(prop?.initializer && ts.isJsxExpression(prop.initializer), `${path}: current preference`);
      assert.equal(evaluate(`return ${prop.initializer.expression.getText(file)}`, bindings), current);
    }
  }
});



test("default model selection only uses OpenCode and retains custom OpenCode model IDs", () => {
  const other = { id: "codex", agentReady: true, models: [{ id: "other-model" }] };
  const opencode = { id: "opencode", agentReady: true, models: [{ id: "provider/server-model" }] };
  assert.equal(defaultSelection([other, opencode], { harness: "codex", model: "old-model" }).harness, "opencode");
  assert.equal(defaultSelection([other, opencode]).model, "provider/server-model");
  assert.equal(defaultSelection([other]), null);
  const custom = { harness: "opencode", model: "provider/custom-model" };
  assert.equal(defaultSelection([opencode], custom), custom);
});
