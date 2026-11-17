import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
const audit = new URL(process.env.DATABASE_URL!);
audit.pathname = "/anilearn_audit_20261007";
process.env.DATABASE_URL = audit.href;
async function main() {
  const { db, pool } = await import("../../src/db");
  const { sessions } = await import("../../src/db/schema");
  const { applyPlan } = await import("../../src/lib/server/session-plan");
  try {
    const rows = await db.select().from(sessions);
    const cycle = rows.find((row) => row.completionConfirmations?.["0"]?.goalIds.includes("audit-expanded-goal"));
    const baseline = rows.find((row) => row.plan?.version === 1 && row.plan.units.length === 2);
    assert.ok(cycle?.snapshot && cycle.plan && baseline?.plan);
    const original = { ...baseline.plan, version: 3 };
    let result = await applyPlan(cycle, original, cycle.snapshot.problems);
    assert.equal(result.progress["0"], "done");
    const changed = { ...original, version: 4, units: original.units.map((unit) => unit.idx === 0 ? { ...unit, goals: [...unit.goals, { ...unit.goals[0], id: "audit-new-goal" }] } : unit) };
    result = await applyPlan(result, changed, cycle.snapshot.problems);
    assert.notEqual(result.progress["0"], "done");
    result = await applyPlan(result, { ...original, version: 5 }, cycle.snapshot.problems);
    assert.equal(result.progress["0"], "done");
    console.log("Passed: earlier confirmed goals survive reconfirmation and plan changes; new goal reopens progress.");
  } finally { await pool.end(); }
}
void main();
