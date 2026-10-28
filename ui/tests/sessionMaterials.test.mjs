import assert from "node:assert/strict";
import test from "node:test";
import { sessionMaterialIds } from "../src/sessionMaterials.ts";

test("workspace materials follow the active branch and deduplicate repeated imports", () => {
  const message = (id, parentId, material) => ({ id, parentId, parts: [{ type: "material", text: material }] });
  const messages = [message("root", null, "first"), message("old", "root", "abandoned"), message("new", "root", "second"), message("leaf", "new", "first")];
  assert.deepEqual(sessionMaterialIds(messages, "leaf"), ["first", "second"]);
  assert.deepEqual(sessionMaterialIds(messages, "old"), ["abandoned", "first"]);
  assert.deepEqual(sessionMaterialIds(messages, null), []);
  assert.deepEqual(sessionMaterialIds(messages, "deleted"), []);
});

test("workspace materials tolerate incomplete ancestry and stop malformed cycles", () => {
  assert.deepEqual(sessionMaterialIds([{ id: "a", parentId: "a", parts: [{ type: "text", text: "not-a-package" }, { type: "material", text: "package" }] }], "a"), ["package"]);
});
