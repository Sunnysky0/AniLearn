import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../db/schema";

interface SchemaDatabase {
  query<Row extends Record<string, unknown>>(text: string): Promise<{ rows: Row[] }>;
}
interface ColumnRow { table_name: string; column_name: string; is_nullable: string }
interface KeyRow { table_name: string; columns: string[]; is_primary: boolean }
interface RequiredKey { columns: string[]; primary: boolean }

// Derive the contract from the same schema used by the app and migration tool.
// This module accepts a caller-owned connection and never opens a work pool.
const requiredTables = Object.values(schema).map(table => {
  const config = getTableConfig(table);
  const keys: RequiredKey[] = config.primaryKeys.map(key => ({ columns: key.columns.map(column => column.name), primary: true }));
  const primary = config.columns.filter(column => column.primary).map(column => column.name);
  if (primary.length) keys.push({ columns: primary, primary: true });
  for (const index of config.indexes.filter(index => index.config.unique)) {
    // Current uniqueness guards all use ordinary, unconditional column indexes.
    if (index.config.where || index.config.columns.some(column => !("name" in column) || !column.name)) {
      throw new Error(`Unsupported readiness index on ${config.name}`);
    }
    keys.push({ columns: index.config.columns.map(column => (column as { name: string }).name), primary: false });
  }
  for (const key of config.uniqueConstraints) keys.push({ columns: key.columns.map(column => column.name), primary: false });
  for (const column of config.columns.filter(column => column.isUnique)) keys.push({ columns: [column.name], primary: false });
  return { name: config.name, columns: config.columns, keys };
});

export class SchemaNotReadyError extends Error {
  readonly code = "SCHEMA_NOT_READY";
  constructor(readonly missing: string[]) {
    super(`数据库表结构尚未就绪。请先备份并审查数据库增量迁移，或运行 npm run db:push 后重试；启动器不会修改表结构。缺失或不兼容项：${missing.slice(0, 16).join("、")}${missing.length > 16 ? "等" : ""}。`);
    this.name = "SchemaNotReadyError";
  }
}

export async function assertSchemaReady(database: SchemaDatabase): Promise<void> {
  const [columns, keys] = await Promise.all([
    database.query<ColumnRow & Record<string, unknown>>("SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema='public'"),
    database.query<KeyRow & Record<string, unknown>>(`
      SELECT t.relname AS table_name, i.indisprimary AS is_primary,
        ARRAY(SELECT a.attname::text
          FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, position)
          JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
          WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns
      FROM pg_index i
      JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indpred IS NULL AND i.indexprs IS NULL`),
  ]);
  const missing: string[] = [];
  const signature = (names: string[]) => [...names].sort().join("\0");
  for (const table of requiredTables) {
    const actualColumns = columns.rows.filter(column => column.table_name === table.name);
    if (!actualColumns.length) { missing.push(table.name); continue; }
    for (const column of table.columns) {
      const actual = actualColumns.find(item => item.column_name === column.name);
      if (!actual || (column.notNull && actual.is_nullable !== "NO")) missing.push(`${table.name}.${column.name}`);
    }
    for (const key of table.keys) {
      if (!keys.rows.some(actual => actual.table_name === table.name && (!key.primary || actual.is_primary) && signature(actual.columns) === signature(key.columns))) {
        missing.push(`${table.name}(${key.columns.join(",")}) ${key.primary ? "PRIMARY KEY" : "UNIQUE"}`);
      }
    }
  }
  if (missing.length) throw new SchemaNotReadyError(missing);
}
