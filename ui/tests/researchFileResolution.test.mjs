import test from "node:test";
import assert from "node:assert/strict";
import { queryModules } from "./queryModules.mjs";

const studyPath = "research/study-current/report/参考文献表.md";
function setup(t, { existing = studyPath, study = { id: "study-current" }, checkout = false } = {}) {
  const probes = [];
  const modules = queryModules({
    getProjectFile: async (_project, path) => ({ path, content: "checkout", notFound: !checkout }),
    getArtifactFileMetadata: async (_project, path) => {
      probes.push(path);
      return path === existing ? { presentation: "text" } : null;
    },
    getArtifactFileText: async (_project, path) => ({ content: `body:${path}`, binary: false, truncated: false }),
    getResearchStudy: async (session) => {
      probes.push(`session:${session}`);
      return { study, runs: [] };
    },
  });
  t.after(() => modules.client.clear());
  return { ...modules, probes };
}

for (const source of ["repo", "artifacts"]) {
  test(`${source} links resolve Chinese filenames in the session's research package`, async (t) => {
    const { client, load, probes } = setup(t);
    const result = await client.fetchQuery(load("files").resolvedFileQuery("p", "report/参考文献表.md", source, "s"));
    assert.equal(result.source, "artifact");
    assert.equal(result.file.path, studyPath);
    assert.equal(result.file.content, `body:${studyPath}`);
    assert.deepEqual(probes, ["report/参考文献表.md", "session:s", studyPath]);
  });
}

test("exact project artifacts retain precedence", async (t) => {
  const { client, load, probes } = setup(t, { existing: "report/参考文献表.md" });
  const result = await client.fetchQuery(load("files").resolvedFileQuery("p", "report/参考文献表.md", "repo", "s"));
  assert.equal(result.file.path, "report/参考文献表.md");
  assert.deepEqual(probes, ["report/参考文献表.md"]);
});

test("checkout files and committed refs never resolve to research artifacts", async (t) => {
  const { client, load, probes } = setup(t, { checkout: true });
  assert.equal((await client.fetchQuery(load("files").resolvedFileQuery("p", "report/参考文献表.md", "repo", "s"))).source, "checkout");
  assert.deepEqual(probes, []);
  const missing = setup(t);
  const result = await missing.client.fetchQuery(missing.load("files").resolvedFileQuery("p", "report/参考文献表.md", "repo", "s", "main"));
  assert.equal(result.file.notFound, true);
  assert.deepEqual(missing.probes, []);
});

for (const options of [{ study: null }, { existing: "research/study-other/report/参考文献表.md" }]) {
  test(`missing study or file does not open another study's artifact: ${JSON.stringify(options)}`, async (t) => {
    const { client, load } = setup(t, options);
    const result = await client.fetchQuery(load("files").resolvedFileQuery("p", "report/参考文献表.md", "repo", "s"));
    assert.equal(result.file.notFound, true);
  });
}

test("fully qualified artifact links and sessionless links do not acquire a study prefix", async (t) => {
  const { client, load, probes } = setup(t, { existing: null });
  for (const [path, session] of [[studyPath, "s"], ["report/参考文献表.md", undefined]]) {
    const result = await client.fetchQuery(load("files").resolvedFileQuery("p", path, "repo", session));
    assert.equal(result.file.notFound, true);
  }
  assert.deepEqual(probes, [studyPath, "report/参考文献表.md"]);
});
