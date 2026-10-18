import assert from "node:assert/strict";
import test from "node:test";
import { storageMode } from "../src/storagePolicy.ts";
import { httpErrorMessage } from "../src/httpError.ts";

test("hosted storage fails closed while local installations retain directory controls", () => {
  assert.equal(storageMode(null, false, false), "local");
  assert.equal(storageMode(null, false, true), "loading");
  assert.equal(storageMode(null, true, false), "managed");
  assert.equal(storageMode({ managed: true, canInspect: false, readOnly: true }, false, false), "managed");
  assert.equal(storageMode({ managed: false, canInspect: false, readOnly: true }, false, false), "local");
});

test("proxy error documents never become visible error text", () => {
  const fallback = "Request failed (HTTP 404).";
  for (const [type, body] of [["text/html", "<html><title>404</title></html>"], ["", " \n<!DOCTYPE html><html>nginx</html>"], ["application/xhtml+xml", "<body>Forbidden</body>"]]) {
    assert.equal(httpErrorMessage(404, type, body, fallback), fallback);
  }
  assert.equal(httpErrorMessage(403, "text/plain", "Permission denied"), "Permission denied");
  assert.equal(httpErrorMessage(502, "", ""), "HTTP 502");
});
