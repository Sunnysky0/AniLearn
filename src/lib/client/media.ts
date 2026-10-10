// Browser-only helpers: image downscaling and PDF → image rendering.
import { MAX_PAPER_PAGES, MAX_PAPER_TEXT_BYTES } from "@/lib/types";
import { decodePaperText } from "@/lib/paper-source";

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

export async function fileToJpegBlob(file: Blob, maxSide = 2000, quality = 0.86): Promise<Blob> {
  const url = URL.createObjectURL(file);
  let canvas: HTMLCanvasElement | null = null;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("无法读取该图片（可能是不支持的格式，如 HEIC）"));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 Canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const renderingCanvas = canvas;
    const blob = await new Promise<Blob>((resolve, reject) => renderingCanvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片转换失败。")), "image/jpeg", quality));
    return blob;
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    URL.revokeObjectURL(url);
  }
}

export async function fileToPaperText(file: File): Promise<{ dataUrl: string; mime: string; text: string }> {
  if (file.size > MAX_PAPER_TEXT_BYTES) throw new Error("文本文件过大，单个文件最多 1.5 MB。");
  const bytes = await file.arrayBuffer();
  const text = decodePaperText(new Uint8Array(bytes));
  const mime = /\.tex$/i.test(file.name) ? "text/x-tex" : "text/markdown";
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取该文本文件。"));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
  return { dataUrl, mime, text };
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
  pageLimitMessage = `单份试卷最多 ${maxPages} 页`,
): Promise<string[]> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  try {
  const doc = await task.promise;
  if (doc.numPages > maxPages) {
    throw new Error(`PDF 共 ${doc.numPages} 页，${pageLimitMessage}。请拆分后上传，页面不会被截断。`);
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

export async function pdfToImageBlobs(
  file: File,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Blob[]> {
  const pdfjs = await loadPdfJs();
  signal?.throwIfAborted();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  let destroyed: Promise<void> | null = null;
  const destroy = () => destroyed ??= task.destroy();
  const abort = () => { void destroy().catch(() => { /* The render reports cancellation. */ }); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const doc = await task.promise;
    const out: Blob[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 2000 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("浏览器不支持 Canvas");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        out.push(await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(`PDF 第 ${i} 页转换失败。`)), "image/jpeg", 0.86)));
        onProgress?.(i, doc.numPages);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return out;
  } finally {
    signal?.removeEventListener("abort", abort);
    await destroy();
  }
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
