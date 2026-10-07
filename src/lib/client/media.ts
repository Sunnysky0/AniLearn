// Browser-only helpers: image downscaling and PDF → image rendering.
import { MAX_PAPER_PAGES } from "@/lib/types";

export async function fileToJpegDataUrl(file: Blob, maxSide = 2000, quality = 0.86): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("无法读取该图片（可能是不支持的格式，如 HEIC）"));
      i.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 Canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface PdfViewport {
  width: number;
  height: number;
}
interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: Record<string, unknown>): { promise: Promise<void> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: ArrayBuffer }): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
}

let pdfjsPromise: Promise<PdfJs> | null = null;

/** Load the self-hosted pdf.js build from /public at runtime (bypasses the bundler). */
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    const importer = new Function("u", "return import(u)") as (u: string) => Promise<PdfJs>;
    const base = window.location.origin;
    pdfjsPromise = importer(`${base}/pdfjs/pdf.min.mjs`)
      .then((m) => {
        m.GlobalWorkerOptions.workerSrc = `${base}/pdfjs/pdf.worker.min.mjs`;
        return m;
      })
      .catch((e) => {
        pdfjsPromise = null;
        throw e;
      });
  }
  return pdfjsPromise;
}

export async function pdfToImages(
  file: File,
  onProgress?: (done: number, total: number) => void,
  maxPages = MAX_PAPER_PAGES,
): Promise<string[]> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  try {
  const doc = await task.promise;
  if (doc.numPages > maxPages) {
    throw new Error(`PDF 共 ${doc.numPages} 页，单份试卷最多 ${maxPages} 页。请拆分后上传，页面不会被截断。`);
  }
  const total = doc.numPages;
  const out: string[] = [];
  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 2000 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 Canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    out.push(canvas.toDataURL("image/jpeg", 0.86));
    onProgress?.(i, total);
  }
  return out;
  } finally { await task.destroy(); }
}

export function downloadText(filename: string, text: string, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
