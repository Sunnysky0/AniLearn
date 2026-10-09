const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
require("@next/env").loadEnvConfig(process.cwd());

const prompt = "Use case: illustration-story. Asset type: square anime tutor avatar for AniLearn. Subject: Artoria Pendragon, Saber from Fate/stay night, blonde hair in her recognizable braided bun with blue ribbon, green eyes, blue dress with silver armor at the shoulders. Calm serious kind and responsible expression, looking at the viewer. Composition: centered head-and-shoulders portrait with ample space around the entire head, clean pale background. Style: polished Japanese anime cel-shaded illustration, crisp linework, coherent anatomy. No text, watermark or additional characters.";

async function main() {
  const baseUrl = process.env.IMAGE_GENERATION_BASE_URL;
  const key = process.env.IMAGE_GENERATION_API_KEY;
  if (!baseUrl || !key) throw new Error("Image service configuration is missing.");
  // The bundled CLI requires base64; compatible gateways may default to URLs.
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      body.response_format = "b64_json";
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/images/generations`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) throw new Error(`Image service returned HTTP ${response.status}.`);
      const result = await response.json();
      for (const item of result.data ?? []) {
        if (!item.b64_json && item.url) {
          const imageUrl = new URL(item.url);
          if (!["http:", "https:"].includes(imageUrl.protocol)) throw new Error("Unsupported image result URL.");
          const image = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
          if (!image.ok) throw new Error("Unable to retrieve the generated image.");
          item.b64_json = Buffer.from(await image.arrayBuffer()).toString("base64");
          delete item.url;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : "Image adapter failed." } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cli = path.join(process.env.USERPROFILE, ".codex/skills/.system/imagegen/scripts/image_gen.py");
    const child = spawn("python", [cli, "generate", "--prompt", prompt, "--size", "1024x1024", "--quality", "high", "--out", "output/imagegen/artoria.png"], {
      windowsHide: true, stdio: "inherit",
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OPENAI_API_KEY: key, OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` },
    });
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    if (status) throw new Error("Avatar generation failed.");
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
