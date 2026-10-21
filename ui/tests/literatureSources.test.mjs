import assert from "node:assert/strict";
import test from "node:test";
import { literatureSources, externalLiteratureSources } from "../src/literatureSources.ts";

test("shared literature catalog includes all four adapters, including PubMed", () => {
  assert.deepEqual(literatureSources.map(item => item.id), ["alphaxiv", "openalex", "biorxiv", "pubmed"]);
});

test("publisher directories use official links without becoming search adapter IDs", () => {
  assert.deepEqual(externalLiteratureSources.map(item => item.id), ["ieee", "cnki"]);
  const ids = new Set(literatureSources.map(item => item.id));
  for (const item of [...literatureSources, ...externalLiteratureSources]) {
    assert.equal(new URL(item.url).protocol, "https:");
    assert.ok(item.description.length > 0);
  }
  assert.ok(externalLiteratureSources.every(item => !ids.has(item.id)));
});
