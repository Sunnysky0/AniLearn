import { getSettings, resolveFishKey } from "@/lib/server/settings";
import type { VoiceItem } from "@/lib/types";
import { fishErrorResponse, fishRequest } from "@/lib/server/fish";

export const dynamic = "force-dynamic";

interface FishModel {
  _id: string;
  title?: string;
  description?: string;
  cover_image?: string;
  languages?: string[];
  like_count?: number;
  task_count?: number;
  author?: { nickname?: string };
  samples?: { audio?: string }[];
}

function coverUrl(c?: string) {
  if (!c) return "";
  if (/^https?:\/\//.test(c)) return c;
  return `https://public-platform.r2.fish.audio/${c.replace(/^\//, "")}`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const lang = url.searchParams.get("lang") ?? "ja";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const mine = url.searchParams.get("mine") === "1";

  const s = await getSettings();
  const { key } = resolveFishKey(s);
  if (!key) return Response.json({ error: "尚未配置 Fish Audio API Key，请先在「设置」中填写。" }, { status: 400 });

  const params = new URLSearchParams({ page_size: "12", page_number: String(page), sort_by: "task_count" });
  if (q) params.set("title", q);
  if (lang && lang !== "all") params.set("language", lang);
  if (mine) params.set("self", "true");

  try {
    const j = await fishRequest(`/model?${params.toString()}`, { key, proxyUrl: s.fish.proxyUrl }, {
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(12_000)]),
    }, async (response) => await response.json() as { total?: number; items?: FishModel[]; has_more?: boolean });
    const items: VoiceItem[] = (j.items ?? []).map((it) => ({
      id: it._id,
      title: it.title ?? "未命名声音",
      description: it.description ?? "",
      cover: coverUrl(it.cover_image),
      languages: it.languages ?? [],
      author: it.author?.nickname ?? "",
      likes: it.like_count ?? 0,
      uses: it.task_count ?? 0,
      sample: it.samples?.[0]?.audio ?? null,
    }));
    return Response.json({ total: j.total ?? items.length, items, hasMore: !!j.has_more });
  } catch (e) {
    return fishErrorResponse(e);
  }
}
