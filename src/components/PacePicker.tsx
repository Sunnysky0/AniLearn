"use client";
import { PACES, type TeachingPace } from "@/lib/types";
export default function PacePicker({ value, onChange, disabled = false }: { value: TeachingPace; onChange: (value: TeachingPace) => void; disabled?: boolean }) {
  return <select aria-label="讲解档位" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as TeachingPace)} className="max-w-full border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900">
    {PACES.map((p) => <option value={p.id} key={p.id}>{p.name} · {p.description}</option>)}
  </select>;
}
