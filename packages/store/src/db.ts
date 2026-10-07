import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/** Minimal SQL surface shared by node-postgres (production) and PGlite (tests). */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export function pgDb(pool: Pool): Db {
  const wrap = (client: Pool | PoolClient): Db => ({
    async query(sql, params) {
      const res = await client.query(sql, params as unknown[]);
      return { rows: res.rows };
    },
    async transaction(fn) {
      if (client !== pool) return fn(wrap(client)); // already inside a transaction
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN");
        const out = await fn(wrap(conn));
        await conn.query("COMMIT");
        return out;
      } catch (err) {
        await conn.query("ROLLBACK");
        throw err;
      } finally {
        conn.release();
      }
    },
  });
  return wrap(pool);
}

interface PGliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>): Promise<T>;
}

export function pgliteDb(db: PGliteLike): Db {
  const inTx = (tx: { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }): Db => ({
    query: (sql, params) => tx.query(sql, params),
    transaction: (fn) => fn(inTx(tx)),
  });
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn) => db.transaction((tx) => fn(inTx(tx))),
  };
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Apply pending migrations in filename order. `execScript` runs multi-statement SQL. */
export async function migrate(db: Db, execScript: (sql: string) => Promise<unknown>): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set<string>();
  try {
    const res = await db.query<{ version: string }>("SELECT version FROM schema_migrations");
    res.rows.forEach((r) => applied.add(r.version));
  } catch {
    // first run: table does not exist yet
  }
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    await execScript(await readFile(MIGRATIONS_DIR + file, "utf8"));
    await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    ran.push(file);
  }
  return ran;
}
