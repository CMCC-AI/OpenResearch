import assert from "node:assert/strict";
import test from "node:test";

import { composerStashContent, getComposerStashStore } from "../src/composerStash.ts";

test("an empty composer leaves nothing behind", () => {
  const live = { draft: "", attachments: [], annotations: [] };
  assert.equal(composerStashContent(live, null), null);
});

test("an untouched demo prefill leaves nothing behind", () => {
  const live = { draft: "Run the Muon matrix LR 2× probe experiment", attachments: [], annotations: [] };
  assert.equal(composerStashContent(live, live.draft), null);
});

test("a prefill edited by the user is stashed as their draft", () => {
  const prefill = "Run the Muon matrix LR 2× probe experiment";
  const live = { draft: `${prefill} but on GPU`, attachments: [], annotations: [] };
  assert.equal(composerStashContent(live, prefill)?.draft, live.draft);
  // An attachment paired with the untouched prefill is still user content.
  const withFile = { draft: prefill, attachments: [{ dataUrl: "data:,a" }], annotations: [] };
  assert.ok(composerStashContent(withFile, prefill));
});

test("stashed annotations drop their transcript DOM ranges", () => {
  const live = {
    draft: "",
    attachments: [],
    annotations: [{ id: "a1", text: "selected", range: { fake: "dom-range" } }],
  };
  const stashed = composerStashContent(live, null);
  assert.deepEqual(stashed.annotations, [{ id: "a1", text: "selected" }]);
});


test("route remounts retain composer content while a runtime change clears it", () => {
  const first = getComposerStashStore(10);
  first.set("project:session", { draft: "未发送的研究说明", attachments: [], annotations: [] });
  assert.equal(getComposerStashStore(10).get("project:session").draft, "未发送的研究说明");
  assert.equal(getComposerStashStore(10).has("other:session"), false);
  const nextRuntime = getComposerStashStore(11);
  assert.equal(nextRuntime.size, 0);
  first.set("outgoing:session", { draft: "旧运行时退出时保存的内容", attachments: [], annotations: [] });
  assert.equal(nextRuntime.size, 0);
});
