import assert from "node:assert/strict";
import test from "node:test";
import { createAutosave } from "../src/workflow/autosave.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("autosave coalesces rapid edits into one save", async () => {
  let saved = 0;
  const saver = createAutosave(async () => { saved += 1; }, 10);
  saver.schedule();
  await sleep(5);
  saver.schedule();
  await sleep(30);
  assert.equal(saved, 1);
  saver.dispose();
});

test("flush settles a pending change immediately and skips when clean", async () => {
  let saved = 0;
  const saver = createAutosave(async () => { saved += 1; }, 20);
  saver.schedule();
  await saver.flush();
  assert.equal(saved, 1);
  await saver.flush();
  assert.equal(saved, 1);
  saver.dispose();
});

test("failures keep the chain alive so the next flush retries", async () => {
  let attempts = 0;
  const saver = createAutosave(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("offline");
  }, 5);
  saver.schedule();
  await sleep(20);
  assert.equal(attempts, 1);
  saver.schedule();
  await saver.flush();
  assert.equal(attempts, 2);
  saver.dispose();
});

test("flush waits for an in-flight save and reruns it when edits landed mid-save", async () => {
  let releaseFirst = () => {};
  let saved = 0;
  const saver = createAutosave(async () => {
    saved += 1;
    if (saved === 1) await new Promise((resolve) => { releaseFirst = resolve; });
  }, 5);
  saver.schedule();
  await sleep(20);
  assert.equal(saved, 1);
  saver.schedule();
  const done = saver.flush();
  releaseFirst();
  await done;
  assert.equal(saved, 2);
  saver.dispose();
});

test("dispose stops future schedules after settling the pending change", async () => {
  let saved = 0;
  const saver = createAutosave(async () => { saved += 1; }, 5);
  saver.schedule();
  await saver.dispose();
  assert.equal(saved, 1);
  saver.schedule();
  await sleep(20);
  assert.equal(saved, 1);
});
