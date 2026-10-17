import { pool } from "@/db";
import { assertSchemaReady, SchemaNotReadyError } from "@/lib/server/schema-readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await assertSchemaReady(pool);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof SchemaNotReadyError) {
      return Response.json({ ok: false, code: error.code, error: "数据库需要升级，请先完成数据库升级后重试。", missing: error.missing }, { status: 503 });
    }
    return Response.json({ ok: false, code: "DATABASE_UNAVAILABLE", error: "数据库暂时无法连接，请检查启动器状态。" }, { status: 503 });
  }
}
