import test from "node:test";
import assert from "node:assert/strict";
import { validateApiResponse } from "../src/apiValidation.ts";

test("core responses reject incompatible envelopes before cache insertion", () => {
  for (const [url, value] of [["/api/projects", { projects: {} }], ["/api/runs/r", { run: { id: "r" } }], ["/api/chat/sessions/s/messages", { messages: [{ id: "m", parts: null }] }]])
    assert.throws(() => validateApiResponse(url, value), /不兼容/);
});
test("core responses preserve optional and additive fields", () => {
  validateApiResponse("/api/projects", { projects: [{ id: "p", updatedAt: 1, name: "project", repoPath: "/repo", futureField: true }] });
  validateApiResponse("/api/chat/sessions/s/messages", { messages: [{ id: "m", role: "assistant", createdAt: 0, parts: [{ id: "p", type: "text", text: "answer" }] }], activeLeafId: "m" });
  validateApiResponse("/api/settings/ui-state", { newSetting: true });
});
