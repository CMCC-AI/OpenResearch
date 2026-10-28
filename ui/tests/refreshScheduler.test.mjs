import test from "node:test";
import assert from "node:assert/strict";
import { refreshScheduler } from "../src/queries/refreshScheduler.ts";

test("continuous token events bound summary requests and retain the final refresh", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const scheduler = refreshScheduler(() => reads++, 5_000);
  for (let i = 0; i < 6_000; i++) {
    scheduler.schedule();
    t.mock.timers.tick(10);
  }
  assert.equal(reads, 12);
  scheduler.schedule();
  t.mock.timers.tick(5_000);
  assert.equal(reads, 13);
  scheduler.schedule();
  scheduler.cancel();
  t.mock.timers.tick(5_000);
  assert.equal(reads, 13);
});
