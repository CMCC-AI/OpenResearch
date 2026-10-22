import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// SQLite holds the OS file lock. Process death releases ownership automatically;
// the database file may remain and is safe to reuse. Never delete a live lock.
export async function acquireRunnerLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const legacy = await stat(join(directory, "connector.lock")).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (legacy)
    throw new Error(
      "Legacy connector.lock exists; stop the old runner and remove its stale lock before upgrading",
    );
  const database = new DatabaseSync(join(directory, "connector.lock.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (cause) {
    database.close();
    throw new Error("Another executor owns this runner state directory", {
      cause,
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    database.close();
  };
}
