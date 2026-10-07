import { db } from "@/db";
import { tutors } from "@/db/schema";
import { listTutors, sanitizeTutorInput, toTutorDTO } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await listTutors());
}

export async function POST(req: Request) {
  const input = sanitizeTutorInput(await req.json().catch(() => ({})));
  const [row] = await db.insert(tutors).values({ ...input, isPreset: false }).returning();
  return Response.json(toTutorDTO(row));
}
