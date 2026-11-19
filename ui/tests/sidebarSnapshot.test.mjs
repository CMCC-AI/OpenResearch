import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSidebarSnapshots,
  readSidebarProjectsSnapshot,
  readSidebarSessionsSnapshot,
  writeSidebarProjectsSnapshot,
  writeSidebarSessionsSnapshot,
} from "../src/sidebarSnapshot.ts";

function installMemoryStorage() {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  return () => {
    globalThis.localStorage = previous;
  };
}

test("sidebar snapshot caches projects and sessions per user and clears busy/logout state", (t) => {
  t.after(installMemoryStorage());
  const project = {
    id: "p1",
    name: "Project 1",
    slug: "project-1",
    githubOwner: "",
    githubRepo: "",
    baselineBranch: "main",
    repoPath: "/tmp/p1",
    path: "/tmp/p1",
    githubEnabled: false,
    artifactsDir: "/tmp/p1/artifacts",
    createdAt: 1,
    updatedAt: 2,
  };
  const session = {
    id: "s1",
    projectId: "p1",
    title: "Session 1",
    busy: true,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  };

  assert.equal(readSidebarProjectsSnapshot("user-a"), undefined);
  writeSidebarProjectsSnapshot("user-a", [project]);
  writeSidebarSessionsSnapshot("user-a", "p1", [session]);

  assert.equal(readSidebarProjectsSnapshot("user-a")?.[0].name, "Project 1");
  assert.equal(readSidebarProjectsSnapshot("user-b"), undefined);

  const cachedSession = readSidebarSessionsSnapshot("user-a", "p1")?.[0];
  assert.equal(cachedSession?.title, "Session 1");
  assert.equal(cachedSession?.busy, false);

  clearSidebarSnapshots("user-a");
  assert.equal(readSidebarProjectsSnapshot("user-a"), undefined);
  assert.equal(readSidebarSessionsSnapshot("user-a", "p1"), undefined);
});

test("sidebar snapshot retains quick-chat sessions even when projects list is empty", (t) => {
  t.after(installMemoryStorage());
  const quickSession = {
    id: "qc1",
    projectId: "quick-chat",
    title: "Quick Question",
    busy: true,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  };

  writeSidebarSessionsSnapshot("user-a", "quick-chat", [quickSession]);
  writeSidebarProjectsSnapshot("user-a", []);

  const cached = readSidebarSessionsSnapshot("user-a", "quick-chat")?.[0];
  assert.equal(cached?.id, "qc1");
  assert.equal(cached?.busy, false);
});
