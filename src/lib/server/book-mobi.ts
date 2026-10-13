import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_BOOK_EXPANDED_BYTES, MAX_BOOK_UPLOAD_BYTES } from "@/lib/types";

export interface MobiCapability { available: boolean; error: string | null }
let capability: { executable: string; checkedAt: number; result: MobiCapability } | null = null;

function converterPath() {
  const configured = process.env.CALIBRE_EBOOK_CONVERT?.trim();
  return configured && path.isAbsolute(configured) ? configured : null;
}

function runConverter(executable: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let settled = false;
    let stderrBytes = 0;
    // Conversion diagnostics can contain paths or book content; don't return or log them.
    child.stderr?.on("data", (data: Buffer) => { stderrBytes += data.length; if (stderrBytes > 1024 * 1024) child.stderr?.destroy(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill(); // This PID is our child; never stop another Calibre process.
      reject(new Error("MOBI 转换超时，请重试或上传 EPUB"));
    }, timeoutMs);
    child.on("error", () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("无法启动配置的 Calibre 转换器")); } });
    child.on("close", code => { if (!settled) { settled = true; clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("MOBI 转换失败；加密或损坏的文件无法导入")); } });
  });
}

export async function getMobiCapability(): Promise<MobiCapability> {
  const executable = converterPath();
  if (!executable) return { available: false, error: "MOBI 导入需要配置 CALIBRE_EBOOK_CONVERT 的绝对路径；可直接上传 EPUB" };
  if (capability?.executable === executable && Date.now() - capability.checkedAt < 60000) return capability.result;
  let result: MobiCapability;
  try {
    if (!(await stat(executable)).isFile()) throw new Error("转换器不存在");
    await runConverter(executable, ["--version"], 10000);
    result = { available: true, error: null };
  } catch { result = { available: false, error: "配置的 Calibre 转换器不可用；请检查路径或上传 EPUB" }; }
  capability = { executable, checkedAt: Date.now(), result };
  return result;
}

export async function convertMobi(data: Buffer): Promise<Buffer> {
  if (!data.length || data.length > MAX_BOOK_UPLOAD_BYTES) throw new Error("电子书文件大小无效");
  const available = await getMobiCapability();
  if (!available.available) throw new Error(available.error ?? "MOBI 转换器不可用");
  const executable = converterPath()!;
  const directory = await mkdtemp(path.join(os.tmpdir(), "anilearn-book-"));
  try {
    const input = path.join(directory, "source.mobi");
    const output = path.join(directory, "converted.epub");
    await writeFile(input, data, { flag: "wx" });
    await runConverter(executable, [input, output, "--no-default-epub-cover"], 120000);
    const size = (await stat(output)).size;
    if (!size || size > MAX_BOOK_EXPANDED_BYTES) throw new Error("转换后的 EPUB 不能超过 256 MiB");
    return await readFile(output);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
}
