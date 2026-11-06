import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import * as transport from '../src/readOnlyApi.ts';
import * as preview from '../src/previewText.ts';
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../src/materialReadCoverage.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const api = {};
new Function('require', 'exports', code)(id => id === './readOnlyApi' ? transport : id === './previewText' ? preview : require(id), api);
const material = { id: 'package', projectId: 'project', ready: true, files: [{ id: 'SRC-0001', path: 'notes.txt', sha256: 'a'.repeat(64), format: 'text' }] };
function payload() {
  return { schemaVersion: 1, projectId: 'project', packageId: 'package', source: null, session: null, study: null, measuredAt: 1,
    coverage: { consideredEvents: 5, excluded: { outputPending: 1 }, meaning: 'confirmed output only', groups: [{
      scope: { packageId: 'package', source: 'SRC-0001', path: 'notes.txt', sha256: 'a'.repeat(64), format: 'text', studyId: null, planVersion: null,
        taskId: null, taskSessionId: null, conversationId: 'reader', inPlanInputs: null, page: null,
        view: { parser: 'utf8-lines', parserVersion: null, executableSha256: null, viewRevision: 'numbered-lines-v1', textSha256: 'b'.repeat(64) } },
      ranges: [[1, 3], [5, 5]], coveredLines: 4, viewTotalLines: 7, producerVersions: ['0.2.23-mobilesci.3', '0.2.23-mobilesci.4'],
    }] } };
}
test('range identity preserves producer observations without counting them as separate views', () => {
  const value = payload();
  assert.equal(api.parseMaterialCoverage(value, material), value);
  assert.equal(value.coverage.groups[0].coveredLines, 4);
  assert.deepEqual(value.coverage.groups[0].producerVersions, ['0.2.23-mobilesci.3', '0.2.23-mobilesci.4']);
  assert.equal(api.coverageUrl('package/id', { session: '会话 α', source: 'SRC/1' }), '/api/materials/package%2Fid/coverage?session=%E4%BC%9A%E8%AF%9D+%CE%B1&source=SRC%2F1');
});
test('malformed, overlapping, duplicate, mismatched and partial unions fail closed', () => {
  const mutations = [
    v => { v.projectId = 'private'; }, v => { v.packageId = 'other'; }, v => { v.schemaVersion = 2; },
    v => { v.coverage.groups[0].scope.source = 'SRC-9999'; }, v => { v.coverage.groups[0].scope.sha256 = 'c'.repeat(64); },
    v => { v.coverage.groups[0].scope.path = 'different.txt'; }, v => { v.coverage.groups[0].scope.view.parser = 'unknown'; },
    v => { v.coverage.groups[0].ranges = [[1,3], [3,4]]; }, v => { v.coverage.groups[0].ranges = [[1,3], [4,4]]; },
    v => { v.coverage.groups[0].ranges = [[1,8]]; }, v => { v.coverage.groups[0].coveredLines = 3; },
    v => { v.coverage.groups[0].producerVersions = ['duplicate', 'duplicate']; },
    v => { v.coverage.groups.push(structuredClone(v.coverage.groups[0])); },
    v => { v.coverage.consideredEvents = 10001; }, v => { v.coverage.excluded = { unknownReason: 1 }; },
    v => { v.coverage.excluded = { outputFailed: 6 }; }, v => { v.coverage.groups[0].scope.page = 1; },
    v => { v.coverage.groups[0].scope.view.textSha256 = 'unknown'; }, v => { v.coverage.groups[0].scope.planVersion = -1; },
  ];
  for (const change of mutations) { const value = payload(); change(value); assert.throws(() => api.parseMaterialCoverage(value, material), /不一致/); }
  assert.throws(() => api.parseMaterialCoverage(payload(), material, { session: 'other' }), /不一致/);
});
test('distinct plan and task ranges remain separate and PDF totals refer only to one page', () => {
  const value = payload();
  value.coverage.groups.push(structuredClone(value.coverage.groups[0]));
  value.coverage.groups[1].scope.taskId = 'second'; value.coverage.groups[1].scope.planVersion = 2; value.coverage.groups[1].scope.studyId = 'study'; value.coverage.groups[1].scope.taskSessionId = 'worker'; value.coverage.groups[1].scope.conversationId = null;
  api.parseMaterialCoverage(value, material);
  const pdf = payload(), file = { ...material.files[0], format: 'pdf' };
  pdf.coverage.groups[0].scope.format = 'pdf'; pdf.coverage.groups[0].scope.page = 2;
  pdf.coverage.groups[0].scope.view = { ...pdf.coverage.groups[0].scope.view, parser: 'pdftotext-layout', parserVersion: '24.02', executableSha256: 'c'.repeat(64) };
  api.parseMaterialCoverage(pdf, { ...material, files: [file] });
});
test('case copies resolve ranges without private fallback and missing snapshots stay unavailable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('must not contact private executor'); };
  for (const copied of [true, false]) {
    const clear = transport.installReadOnlyApi(transport.createReadOnlyProjectApi({ id: 'case', base: '/account', admin: false,
      workspace: { projectId: 'project', sessionId: 'reader', responses: copied ? { [api.coverageUrl('package')]: payload() } : {}, assets: {} } }));
    try {
      if (copied) assert.equal((await api.loadMaterialCoverage(material, {}, new AbortController().signal)).coverage.groups.length, 1);
      else await assert.rejects(api.loadMaterialCoverage(material, {}, new AbortController().signal), /不能据此判断/);
    } finally { clear(); }
  }
  globalThis.fetch = original;
});
test('bounded response reading cancels oversized streams and never retries another endpoint', async () => {
  const original = globalThis.fetch; let calls = 0, cancelled = false;
  globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)); }, cancel() { cancelled = true; } })); };
  try { await assert.rejects(api.loadMaterialCoverage(material, {}, new AbortController().signal), /超过 2 MiB/); assert.equal(calls, 1); assert.equal(cancelled, true); }
  finally { globalThis.fetch = original; }
});
test('backend failures and HTML do not become empty reading results', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [new Response('<html>old SPA</html>'), Response.json({ error: '请缩小范围' }, { status: 400 })]) {
      globalThis.fetch = async () => response;
      await assert.rejects(api.loadMaterialCoverage(material, {}, new AbortController().signal), /解析|缩小范围/);
    }
  } finally { globalThis.fetch = original; }
});
const componentCode = ts.transpileModule(readFileSync(new URL('../src/components/MaterialReadCoverage.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function setup() {
  const state = [], effects = [], pending = [], calls = []; let cursor = 0, effectCursor = 0, generation = 1, context = null;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
    useMemo: read => read(), useSyncExternalStore: (_, read) => read(),
    useEffect(run, deps) { const i = effectCursor++; if (!effects[i] || deps.some((v,n) => !Object.is(v,effects[i].deps[n]))) pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: run() }; }); },
  };
  const exported = {}, mocks = { react: hooks, '../queries/client': { getWorkspaceGeneration: () => generation, subscribeWorkspace() {} },
    './ReadOnlyWorkspace': { useReadOnlyWorkspace: () => context }, './ui': { Button: 'button', Spinner: 'span' },
    '../materialReadCoverage': { ...api, loadMaterialCoverage: (material, filter, signal) => new Promise((resolve,reject) => calls.push({ material, filter, signal, resolve, reject })) } };
  new Function('require','exports',componentCode)(id => mocks[id] ?? require(id), exported);
  return { calls, exported, scope(value) { generation = value; }, case(value) { context = value; },
    render(value = material) { cursor = 0; effectCursor = 0; return exported.MaterialReadCoverage({ material:value, sessionId:'reader' }); },
    flush() { pending.splice(0).forEach(run => run()); }, unmount() { effects.forEach(e => e.cleanup?.()); } };
}
const tick = () => new Promise(setImmediate);
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children].flat().flatMap(nodes)] : [];
test('workspace/case transitions hide old results before effects and discard late responses', async () => {
  const app = setup(); app.render(); app.flush();
  app.calls[0].resolve(payload()); await tick(); assert.match(renderToStaticMarkup(app.render()), /已确认输出/);
  app.scope(2); assert.doesNotMatch(renderToStaticMarkup(app.render()), /已确认输出/); app.flush();
  assert.equal(app.calls[0].signal.aborted, true);
  app.case({ caseId:'next-case' }); assert.match(renderToStaticMarkup(app.render()), /正在汇总/); app.flush();
  app.calls[1].reject(new Error('late private failure')); await tick();
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /late private failure/);
  app.unmount(); assert.equal(app.calls[2].signal.aborted,true);
});
test('failures remain explicit and retry clears stale errors', async () => {
  const app = setup(); app.render(); app.flush(); app.calls[0].reject(new Error('budget exceeded')); await tick();
  const tree = app.render(); assert.match(renderToStaticMarkup(tree), /budget exceeded/);
  nodes(tree).find(n => n.type === 'button' && n.props.children === '重试读取范围').props.onClick();
  assert.match(renderToStaticMarkup(app.render()), /正在汇总/); app.flush();
  app.calls[1].resolve({ ...payload(), coverage:{ groups:[], consideredEvents:0, excluded:{}, meaning:'none' } }); await tick();
  assert.match(renderToStaticMarkup(app.render()), /不能证明 Agent 未通过其他工具读取/); app.unmount();
});
test('row rendering separates task/plan and page scope, escapes source data, and exposes full identity', () => {
  const app = setup(), value = payload().coverage.groups[0]; value.scope.path = '<script>source</script>'; value.scope.format = 'pdf'; value.scope.page = 2;
  value.scope.taskId = 'task'; value.scope.planVersion = 3;
  const html = renderToStaticMarkup(app.exported.CoverageRow({ group:value }));
  assert.match(html,/任务 task/); assert.match(html,/计划 v3/); assert.match(html,/PDF 第 2 页解析视图/); assert.match(html,/不代表整篇 PDF/);
  assert.match(html,/&lt;script&gt;source/); assert.doesNotMatch(html,/<script>/); assert.match(html,/0.2.23-mobilesci.4/);
});
