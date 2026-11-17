import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";

loadEnvConfig(process.cwd());
async function main() {
const { getSettings, getLLMConfig } = await import("../../src/lib/server/settings");
const { recoverCoverage } = await import("../../src/lib/server/tutor-output");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const session = (await pool.query("SELECT plan,coverage,current_idx FROM sessions WHERE id=$1", [25])).rows[0];
  if (!session?.plan) throw new Error("Fixture session or plan unavailable");
  const idx = session.current_idx;
  const goals = session.plan.units.find((unit: { idx: number }) => unit.idx === idx).goals;
  const saved = session.coverage[String(idx)] ?? {};
  const missing = goals.filter((goal: { id: string }) => !saved[goal.id]);
  const rows = (await pool.query("SELECT content FROM messages WHERE session_id=$1 AND problem_idx=$2 AND role='tutor' AND kind IN ('text','board') ORDER BY id", [25, idx])).rows;
  const boards = (await pool.query("SELECT blocks FROM boards WHERE session_id=$1 AND problem_idx=$2", [25, idx])).rows;
  const sources: string[] = [...rows.map((row) => row.content), ...boards.flatMap((row) => row.blocks.map((block: { md: string }) => block.md))];
  const coverage = Object.fromEntries(goals.filter((goal: { id: string }) => saved[goal.id]).map((goal: { id: string; topic: string }) => [goal.topic, saved[goal.id]]));
  const result = await recoverCoverage(getLLMConfig(await getSettings(), "chat"), coverage, sources, new AbortController().signal, missing.map((goal: { topic: string }) => goal.topic), goals);
  const accepted = Object.entries(result.coverage).filter(([topic]) => missing.some((goal: { topic: string }) => goal.topic === topic));
  const allReal = accepted.every(([, value]) => String(value).split("\n\n").every((quote) => sources.some((source) => source.replace(/\s/g, "").includes(quote.replace(/\s/g, "")))));
  if (!allReal) throw new Error("Accepted quote absent from saved sources");
  console.log(JSON.stringify({ status: result.status, code: result.code ?? null, requestedGoals: missing.length, acceptedGoals: accepted.length, allAcceptedQuotesPresent: allReal }));
} finally {
  await pool.end();
  const { pool: appPool } = await import("../../src/db");
  await appPool.end();
}
}
void main();
