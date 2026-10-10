import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractGoogleDocsUrl,
  GOOGLE_DOC_EXPORT_MAX_BYTES,
  GOOGLE_DOC_MARKDOWN_MAX_BYTES,
  isAllowedGoogleDocsRedirect,
  parseGoogleDocsUrl,
  safeGoogleDocsFilename,
} from "./google-docs";
import { exportGoogleDocs, exportGoogleDocsPdf, GoogleDocsImportError } from "./server/google-docs";

const documentId = "1xYzabcdefghijkLMNOPqrstuvwxyz0123456789";
const shareUrl = `https://docs.google.com/document/d/${documentId}/edit?usp=sharing`;
const pdfData = new TextEncoder().encode("%PDF-1.7\nExample document");

function fetchResponse(status: number, headers: Record<string, string> = {}, body: BodyInit | null = null): typeof fetch {
  return (async () => new Response(body, { status, headers })) as typeof fetch;
}

test("Google Docs link parsing keeps resource keys and finds links in copied text", () => {
  const url = `https://docs.google.com/document/u/0/d/${documentId}/edit?resourcekey=key_123&tab=t.0`;
  assert.deepEqual(parseGoogleDocsUrl(url), { id: documentId, resourceKey: "key_123" });
  assert.equal(extractGoogleDocsUrl(`See this document: ${shareUrl}.`), shareUrl);
  assert.equal(parseGoogleDocsUrl("https://docs.google.com.evil.test/document/d/" + documentId), null);
  assert.equal(parseGoogleDocsUrl("http://docs.google.com/document/d/" + documentId), null);
  assert.equal(parseGoogleDocsUrl("https://drive.google.com/file/d/" + documentId + "/view"), null);
  assert.equal(parseGoogleDocsUrl(`https://docs.google.com/document/d/${documentId}/edit?resourcekey=a%2Fb`), null);
});

test("redirect allowlist rejects lookalikes and permits Google document export hosts", () => {
  assert.equal(isAllowedGoogleDocsRedirect("https://docs.google.com/document/d/example"), true);
  assert.equal(isAllowedGoogleDocsRedirect("https://drive.google.com/uc?id=example"), true);
  assert.equal(isAllowedGoogleDocsRedirect("https://doc-12.docs.googleusercontent.com/export"), true);
  assert.equal(isAllowedGoogleDocsRedirect("https://docs.google.com.evil.test/file"), false);
  assert.equal(isAllowedGoogleDocsRedirect("http://drive.google.com/file"), false);
});

test("export requests PDF for every tab and returns only verified PDF content", async () => {
  const captured: { requested?: URL } = {};
  const fetcher = (async (input: RequestInfo | URL) => {
    captured.requested = new URL(String(input));
    return new Response(pdfData, { headers: { "Content-Disposition": "attachment; filename*=UTF-8''Math%20paper.pdf" } });
  }) as typeof fetch;
  const pdf = await exportGoogleDocsPdf(`https://docs.google.com/document/d/${documentId}/edit?resourcekey=secret`, fetcher, AbortSignal.timeout(1000));
  assert.equal(captured.requested?.hostname, "docs.google.com");
  assert.equal(captured.requested?.pathname, `/document/d/${documentId}/export`);
  assert.equal(captured.requested?.searchParams.get("format"), "pdf");
  assert.equal(captured.requested?.searchParams.has("tab"), false);
  assert.equal(captured.requested?.searchParams.get("resourcekey"), "secret");
  assert.deepEqual(pdf.bytes, pdfData);
  assert.equal(pdf.filename, "Math paper.pdf");
});

test("Google Docs import prefers verified Markdown and returns a text source", async () => {
  const captured: { requested?: URL; accept?: string } = {};
  const markdown = new TextEncoder().encode("# Article\n\nFirst paragraph.");
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.requested = new URL(String(input));
    captured.accept = new Headers(init?.headers).get("accept") ?? undefined;
    return new Response(markdown, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": "attachment; filename*=UTF-8''Foreign%20Article.md" },
    });
  }) as typeof fetch;
  const result = await exportGoogleDocs(`https://docs.google.com/document/d/${documentId}/edit?resourcekey=key_123&tab=t.0`, fetcher, AbortSignal.timeout(1000));
  assert.equal(captured.requested?.searchParams.get("format"), "md");
  assert.equal(captured.requested?.searchParams.has("tab"), false);
  assert.equal(captured.requested?.searchParams.get("resourcekey"), "key_123");
  assert.equal(captured.accept, "text/markdown");
  assert.equal(result.mimeType, "text/markdown");
  assert.equal(result.filename, "Foreign Article.md");
  assert.deepEqual(result.bytes, markdown);
});

test("Google Docs import falls back to PDF when public Markdown export is unavailable or too large", async () => {
  const formats: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const format = new URL(String(input)).searchParams.get("format") ?? "";
    formats.push(format);
    if (format === "md") return new Response("<html>Markdown export unavailable</html>", { headers: { "Content-Type": "text/html" } });
    return new Response(pdfData, { headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=Article.pdf" } });
  }) as typeof fetch;
  const result = await exportGoogleDocs(shareUrl, fetcher, AbortSignal.timeout(1000));
  assert.deepEqual(formats, ["md", "pdf"]);
  assert.equal(result.mimeType, "application/pdf");
  assert.equal(result.filename, "Article.pdf");
  assert.deepEqual(result.bytes, pdfData);

  formats.length = 0;
  const oversizedMarkdown = (async (input: RequestInfo | URL) => {
    const format = new URL(String(input)).searchParams.get("format") ?? "";
    formats.push(format);
    if (format === "md") return new Response("ignored", { headers: { "Content-Length": String(GOOGLE_DOC_MARKDOWN_MAX_BYTES + 1) } });
    return new Response(pdfData, { headers: { "Content-Type": "application/pdf" } });
  }) as typeof fetch;
  const fallback = await exportGoogleDocs(shareUrl, oversizedMarkdown, AbortSignal.timeout(1000));
  assert.deepEqual(formats, ["md", "pdf"]);
  assert.equal(fallback.mimeType, "application/pdf");
});

test("Markdown export does not fall back through an untrusted redirect", async () => {
  const formats: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    formats.push(new URL(String(input)).searchParams.get("format") ?? "");
    return new Response(null, { status: 302, headers: { location: "https://docs.google.com.evil.test/download" } });
  }) as typeof fetch;
  await assert.rejects(
    exportGoogleDocs(shareUrl, fetcher, AbortSignal.timeout(1000)),
    (error: unknown) => error instanceof GoogleDocsImportError && error.status === 400,
  );
  assert.deepEqual(formats, ["md"]);
});

test("export refuses authentication pages and external redirect destinations", async () => {
  await assert.rejects(
    exportGoogleDocsPdf(shareUrl, fetchResponse(200, { "content-type": "text/html" }, "<html>login</html>"), AbortSignal.timeout(1000)),
    (error: unknown) => error instanceof GoogleDocsImportError && error.status === 400,
  );
  const redirect = fetchResponse(302, { Location: "https://docs.google.com.evil.test/download" });
  await assert.rejects(
    exportGoogleDocsPdf(shareUrl, redirect, AbortSignal.timeout(1000)),
    (error: unknown) => error instanceof GoogleDocsImportError && error.status === 400,
  );
});

test("export enforces redirect and byte limits, and sanitizes the returned filename", async () => {
  const redirects = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    return new Response(null, { status: 302, headers: { location: url.href } });
  }) as typeof fetch;
  await assert.rejects(
    exportGoogleDocsPdf(shareUrl, redirects, AbortSignal.timeout(1000)),
    (error: unknown) => error instanceof GoogleDocsImportError && error.message.includes("跳转次数过多"),
  );

  const oversized = fetchResponse(200, { "content-length": String(GOOGLE_DOC_EXPORT_MAX_BYTES + 1) }, pdfData);
  await assert.rejects(
    exportGoogleDocsPdf(shareUrl, oversized, AbortSignal.timeout(1000)),
    (error: unknown) => error instanceof GoogleDocsImportError && error.status === 413,
  );
  assert.equal(safeGoogleDocsFilename('attachment; filename="..\\private\\paper"'), "paper.pdf");
  assert.equal(safeGoogleDocsFilename("attachment; filename*=UTF-8''paper.pdf", ".md"), "paper.md");
  assert.equal(safeGoogleDocsFilename("attachment; filename*=UTF-8''bad%ZZ"), "Google Docs 文档.pdf");
});

test("export observes the caller's timeout signal", async () => {
  const stalled = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
  await assert.rejects(
    exportGoogleDocsPdf(shareUrl, stalled, AbortSignal.timeout(10)),
    (error: unknown) => error instanceof Error && error.name === "TimeoutError",
  );
});
