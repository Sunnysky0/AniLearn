import { Pool } from "pg";

const globalForLocks = globalThis as typeof globalThis & { __aniLearnLockPool?: Pool };
// Locks must not reserve connections from the pool needed to perform the work.
const pool = globalForLocks.__aniLearnLockPool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
});
if (process.env.NODE_ENV !== "production") globalForLocks.__aniLearnLockPool = pool;

const namespaces = { paper: 17421, session: 17422 };

// A dedicated connection keeps this lock effective across app processes.
export async function tryOperationLock(kind: keyof typeof namespaces, id: number) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1, $2) as locked",
      [namespaces[kind], id],
    );
    if (!rows[0].locked) {
      client.release();
      return null;
    }
  } catch (e) {
    client.release(true);
    throw e;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("select pg_advisory_unlock($1, $2)", [namespaces[kind], id]);
      client.release();
    } catch {
      client.release(true);
    }
  };
}
