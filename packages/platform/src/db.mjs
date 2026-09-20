import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
export const createPool = (url) =>
  new pg.Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
export async function transaction(pool, run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(pool) {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(721946)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS platform_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = new URL("../migrations/", import.meta.url);
    for (const version of (await readdir(directory))
      .filter((name) => /^\d+\.sql$/.test(name))
      .sort()) {
      const sql = await readFile(new URL(version, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await db.query(
        "SELECT checksum FROM platform_migrations WHERE version=$1",
        [version],
      );
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${version}`);
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO platform_migrations(version,checksum) VALUES($1,$2)",
        [version, checksum],
      );
    }
  });
}
