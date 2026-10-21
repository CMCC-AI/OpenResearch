import assert from "node:assert/strict";
import test from "node:test";
import { resolveStarterPrompts } from "../src/starterPrompts.ts";

const defaults = Array.from({ length: 4 }, (_, i) => ({ title: `默认 ${i}`, prompt: `问题 ${i}` }));

test("new chats retain four default cards while generation is pending, unavailable, failed or empty", () => {
  for (const data of [undefined, { blank: false, prompts: null }, { blank: false, prompts: [] }, { blank: true, prompts: [] }]) {
    assert.equal(resolveStarterPrompts(data, defaults), defaults);
    assert.equal(resolveStarterPrompts(data, defaults).length, 4);
  }
});

test("project recommendations replace defaults once generation succeeds", () => {
  const prompts = [{ title: "本项目", prompt: "分析本项目" }];
  assert.equal(resolveStarterPrompts({ blank: false, prompts }, defaults), prompts);
  assert.equal(resolveStarterPrompts({ blank: true, prompts }, defaults), defaults);
});
