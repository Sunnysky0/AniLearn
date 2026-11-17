import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, sessions } from "@/db/schema";
import { problemDivider, toMessageDTO, toSessionDTO, type SessionRow } from "./data";
import { goalsFor } from "./learning-plan";
import { COMPLETE_PROBLEM_TEXT, type LearningPlan, type ProblemDTO, type ProblemProgress, type TurnEvent } from "@/lib/types";

// The caller owns the session operation lock. Commit confirmation and progress together.
export async function confirmProblemCompletion(session: SessionRow, plan: LearningPlan, problems: ProblemDTO[], idx: number, text: string): Promise<TurnEvent[]> {
  return db.transaction(async (tx) => {
    const progress: Record<string, ProblemProgress> = { ...session.progress, [String(idx)]: "done" };
    const remaining = plan.units.map((unit) => unit.idx).filter((i) => progress[String(i)] !== "done");
    const nextIdx = remaining.find((i) => i > idx) ?? remaining[0];
    if (nextIdx !== undefined) progress[String(nextIdx)] = "active";
    const now = new Date();
    const [updated] = await tx.update(sessions).set({
      plan,
      progress,
      currentIdx: nextIdx ?? idx,
      status: remaining.length ? "active" : "completed",
      completionConfirmations: {
        ...(session.completionConfirmations ?? {}),
        [String(idx)]: {
          confirmedAt: now.toISOString(),
          planVersion: plan.version,
          goalIds: [...new Set([...(session.completionConfirmations?.[String(idx)]?.goalIds ?? []), ...goalsFor(plan, idx).map((goal) => goal.id)])],
        },
      },
      updatedAt: now,
    }).where(eq(sessions.id, session.id)).returning();
    const [user] = await tx.insert(messages).values({ sessionId: session.id, role: "user", kind: "text", content: text || COMPLETE_PROBLEM_TEXT, problemIdx: idx }).returning();
    const events: TurnEvent[] = [{ type: "user", message: toMessageDTO(user) }];
    if (nextIdx !== undefined) {
      const [divider] = await tx.insert(messages).values({ sessionId: session.id, role: "system", kind: "problem", content: problemDivider(problems[nextIdx]), problemIdx: nextIdx }).returning();
      events.push({ type: "problem", message: toMessageDTO(divider), session: toSessionDTO(updated) });
    }
    events.push({ type: "done", action: remaining.length ? "next" : "finish", intent: "complete_problem", session: toSessionDTO(updated) });
    return events;
  });
}
