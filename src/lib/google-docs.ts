export const GOOGLE_DOC_EXPORT_MAX_BYTES = 20 * 1024 * 1024;
export const GOOGLE_DOC_EXPORT_TIMEOUT_MS = 30_000;
export const GOOGLE_DOC_MAX_REDIRECTS = 5;

export interface GoogleDocsSource {
  id: string;
  resourceKey: string | null;
}

/** Accept only a Google Docs document URL and retain its optional sharing resource key. */
export function parseGoogleDocsUrl(value: string): GoogleDocsSource | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.port || url.username || url.password) return null;
  const match = url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{1,200})(?:\/(?:edit|view|preview|copy))?\/?$/);
  if (!match) return null;
  const resourceKey = url.searchParams.get("resourcekey") ?? url.searchParams.get("resourceKey");
  if (resourceKey !== null && (!/^[A-Za-z0-9_-]{1,512}$/.test(resourceKey))) return null;
  return { id: match[1], resourceKey };
}

/** Find a Docs link embedded in pasted plain text, a URL list, or copied rich-text HTML. */
export function extractGoogleDocsUrl(value: string): string | null {
  const matches = value.match(/https?:\/\/docs\.google\.com\/document\/[^\s<>"']+/giu) ?? [];
  for (const candidate of matches) {
    const cleaned = candidate.replace(/[),.;!?，。）》】]+$/u, "");
    if (parseGoogleDocsUrl(cleaned)) return cleaned;
  }
  return null;
}

export function isAllowedGoogleDocsRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  return url.hostname === "docs.google.com" || url.hostname === "drive.google.com" || url.hostname === "drive.usercontent.google.com" || url.hostname.endsWith(".googleusercontent.com");
}

export function safeGoogleDocsFilename(value: string | null, fallback = "Google Docs 文档.pdf"): string {
  if (!value) return fallback;
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  let filename = "";
  try {
    filename = encoded ? decodeURIComponent(encoded) : value.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1] ?? "";
  } catch {
    return fallback;
  }
  filename = filename.split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f\x7f]/g, "").trim() ?? "";
  if (!filename) return fallback;
  if (!/\.pdf$/i.test(filename)) filename += ".pdf";
  return filename.slice(0, 240);
}
