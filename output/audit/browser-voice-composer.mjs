// Focused QA inventory:
// - All three classrooms: immediate parallel TTS, ordered audio/text/notes, same composer.
// - Image paste/selection/removal, image-only submission, native text paste and IME guards.
// - Reading images: durable storage, lazy retrieval, bounded multimodal history.
// - Shared boundaries: duplicate scripts, mute/resume, interrupted synthesis, text fallback.
// - Settings and tutor previews: fresh requests, cancellation, existing voice samples.
// - Desktop/mobile fit, formula rendering, upload/settings smoke, resource cleanup.
const runVoiceComposerAudit = async (page, fixtures = {}) => {
  const fs = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const base = "http://127.0.0.1:3107";
  const mock = "http://127.0.0.1:4107";
  const results = [];
  const pageErrors = [];
  const submissions = [];
  const ids = { ...fixtures };
  let ttsMode = "normal";
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pass = (test, details = {}) => {
    results.push({ test, outcome: "pass", ...details });
    fs.writeFileSync("output/audit/voice-composer-results.json", JSON.stringify(results, null, 2));
  };
  fs.mkdirSync("output/playwright", { recursive: true });
  const png = fs.readFileSync("public/avatars/rin.png");
  const pngBase64 = png.toString("base64");
  const dataUrl = "data:image/png;base64," + pngBase64;
  const wav = Buffer.alloc(44 + 8000 * 2 * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);

  async function api(path, method = "GET", data, expected = 200) {
    const response = await page.request.fetch(base + path, { method, data });
    const raw = await response.text();
    let value;
    try { value = JSON.parse(raw); }
    catch { value = raw.trim().split("\n").filter(Boolean).map(JSON.parse); }
    assert(response.status() === expected, path + ": expected " + expected + ", got " + response.status() + " " + JSON.stringify(value));
    return value;
  }
  async function sql(query, params = []) {
    const response = await page.request.post(mock + "/sql", { data: { sql: query, params } });
    assert(response.ok(), "isolated SQL fixture failed");
    return response.json();
  }
  async function setModel(model) {
    const settings = await api("/api/settings");
    await api("/api/settings", "PUT", { models: { ...settings.models, chat: { ...settings.models.chat, model } } });
  }
  const textbox = () => page.getByRole("textbox", { name: "课堂消息", exact: true });
  const stopButton = () => page.getByRole("button", { name: "停止讲解", exact: true });
  const idle = () => stopButton().waitFor({ state: "hidden", timeout: 30000 });
  const resetMetrics = () => page.evaluate(() => {
    const q = window.__voiceQa;
    q.requests.length = 0; q.plays.length = 0; q.ended.length = 0;
    q.created.length = 0; q.revoked.length = 0; q.peak = 0;
  });
  const metrics = () => page.evaluate(() => window.__voiceQa);
  async function pasteImage(count = 1) {
    await textbox().click();
    await page.evaluate(async (base64) => {
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([data], { type: "image/png" }) })]);
    }, pngBase64);
    await page.keyboard.press("Control+V");
    await page.getByAltText("待发送图片 " + count, { exact: true }).waitFor();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector('button[aria-label="发送消息"]')?.disabled);
  }
  async function send(text = "") {
    await textbox().fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  }
  async function fit(name, mobile = false) {
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      if (!(await textbox().isVisible())) {
        if (name === "exam") await page.getByRole("tab", { name: "对话", exact: true }).click();
        else await page.getByRole("button", { name: name === "reading" ? "导师" : "对话", exact: true }).click();
      }
    }
    await page.waitForFunction(() => {
      const input = document.querySelector('textarea[aria-label="课堂消息"]');
      const r = input?.getBoundingClientRect();
      const send = document.querySelector('button[aria-label="发送消息"]')?.getBoundingClientRect();
      return r && send && r.width > 0 && r.x >= 0 && r.right <= innerWidth + 1 && send.bottom <= innerHeight + 1;
    });
    const layout = await page.evaluate(() => {
      const input = document.querySelector('textarea[aria-label="课堂消息"]');
      return { rows: input.rows, resize: getComputedStyle(input).resize,
        overflow: document.documentElement.scrollWidth > innerWidth, formulaErrors: document.querySelectorAll(".katex-error").length };
    });
    assert(layout.rows === 2 && layout.resize === "none" && !layout.overflow && !layout.formulaErrors, name + " composer fit failed");
    await page.screenshot({ path: "output/playwright/shared-" + name + (mobile ? "-mobile" : "-desktop") + ".png", scale: "css" });
    if (mobile) await page.setViewportSize({ width: 1440, height: 900 });
    return layout;
  }

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (!/\/turn$/.test(request.url())) return;
    const body = request.postDataJSON();
    submissions.push({ path: new URL(request.url()).pathname, text: body.text ?? "", imageCount: body.images?.length ?? 0,
      intent: body.intent ?? null, paragraphIdx: body.paragraphIdx });
  });
  await page.addInitScript(() => {
    const q = window.__voiceQa = { requests: [], plays: [], ended: [], created: [], revoked: [], active: 0, peak: 0 };
    const blobSpeech = new WeakMap();
    const urlSpeech = new Map();
    const fetchOriginal = window.fetch;
    window.fetch = async function (...args) {
      const path = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
      if (!path.endsWith("/api/tts")) return fetchOriginal.apply(this, args);
      const body = JSON.parse(args[1].body);
      const record = { speech: body.text, fresh: body.fresh === true, at: performance.now() };
      q.requests.push(record); q.peak = Math.max(q.peak, ++q.active);
      try {
        const response = await fetchOriginal.apply(this, args);
        record.ready = performance.now(); record.status = response.status; return response;
      } catch (error) { record.error = error.name; throw error; }
      finally { q.active--; }
    };
    const blobOriginal = Response.prototype.blob;
    Response.prototype.blob = async function () {
      const blob = await blobOriginal.call(this);
      const speech = this.headers.get("x-audit-speech");
      if (speech) blobSpeech.set(blob, decodeURIComponent(speech));
      return blob;
    };
    const createOriginal = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      const url = createOriginal.call(this, blob);
      const speech = blobSpeech.get(blob);
      q.created.push({ url, speech });
      if (speech) urlSpeech.set(url, speech);
      return url;
    };
    const revokeOriginal = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) { q.revoked.push(url); return revokeOriginal.call(this, url); };
    const playOriginal = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const speech = urlSpeech.get(this.src);
      q.plays.push({ speech, at: performance.now() });
      this.addEventListener("ended", () => q.ended.push({ speech, at: performance.now() }), { once: true });
      return playOriginal.call(this);
    };
  });
  await page.route("**/api/tts", async (route) => {
    const body = route.request().postDataJSON();
    const mode = ttsMode;
    const delay = mode === "slow" ? 5000 : body.text.includes("まず") ? 500 : body.text.includes("次に") ? 100 : 300;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (mode === "failure" && body.text.includes("まず")) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "模拟语音失败" }) }).catch(() => {});
    } else {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: wav,
        headers: { "x-audit-speech": encodeURIComponent(body.text) } }).catch(() => {});
    }
  });
  await page.route("**/audit-sample.wav", (route) => route.fulfill({ contentType: "audio/wav", body: wav }));
  await page.route("**/api/voices?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    items: [{ id: "audit-sample", title: "测试样本", author: "audit", uses: 1, languages: ["ja"], cover: "", sample: base + "/audit-sample.wav" }],
  }) }));

  return {
    results,
    async seed() {
      const connection = { id: "voice-composer-audit", name: "Mock classroom", protocol: "openai-compatible", baseUrl: mock + "/v1", apiKey: "audit-dummy-key" };
      await api("/api/settings", "PUT", {
        connections: [connection], models: { chat: { connectionId: connection.id, model: "audit-shared-voice" },
          analysis: { connectionId: connection.id, model: "audit-normal" } },
        fish: { apiKey: "audit-dummy-fish", enabled: true }, autoContinue: false,
      });
      ids.tutor = (await api("/api/tutors"))[0].id;
      ids.paper = (await api("/api/papers", "POST", { title: "共享输入验收试卷", subject: "数学", pace: "thorough" })).id;
      await api("/api/papers/" + ids.paper + "/pages", "POST", { dataUrl });
      const analysis = await api("/api/papers/" + ids.paper + "/analyze", "POST", {});
      assert(analysis.some((event) => event.type === "done"), "fixture paper analysis did not complete");
      ids.exam = (await api("/api/sessions", "POST", { paperId: ids.paper, tutorId: ids.tutor })).id;
      ids.free = (await api("/api/free-sessions", "POST", { tutorId: ids.tutor, requestId: randomUUID() }, 201)).id;
      const paragraphs = [{ id: "audit-p1", text: "Scientists study how cities change.", page: 1 }];
      const reading = await sql("INSERT INTO readings (title, language, status, paragraphs, extracted) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        ["图片提问验收文章", "en", "ready", JSON.stringify(paragraphs), paragraphs[0].text]);
      ids.reading = (await api("/api/reading-sessions", "POST", { readingId: reading[0].id, tutorId: ids.tutor })).id;
      pass("isolated fixtures and additive reading schema", { ids });
      return ids;
    },
    async classrooms(modes = ["exam", "free", "reading"]) {
      for (const mode of modes) {
        const path = mode === "exam" ? "/classroom/" : mode === "free" ? "/free-classroom/" : "/reading-classroom/";
        await page.goto(base + path + ids[mode]);
        if (mode === "free") {
          await page.waitForFunction(() => window.__voiceQa.ended.some((clip) => clip.speech));
          await idle(); await resetMetrics();
          await pasteImage(); await send();
        } else {
          await page.getByRole("button", { name: mode === "exam" ? "开始上课" : "进入阅读课堂", exact: true }).click();
        }
        await page.waitForFunction(() => window.__voiceQa.ended.filter((clip) => clip.speech).length >= 3);
        await idle();
        const q = await metrics();
        const plays = q.plays.filter((clip) => clip.speech);
        const ended = q.ended.filter((clip) => clip.speech);
        assert(q.requests.length === 3 && q.peak === 3 && plays.length === 3, mode + ": TTS was serial or duplicated");
        assert(q.requests.slice(1).every((request) => request.at < ended[0].at), mode + ": synthesis waited for previous audio");
        assert(plays.map((clip) => clip.speech).join("|") === q.requests.map((clip) => clip.speech).join("|"), mode + ": playback reordered");
        assert(q.requests[1].ready < q.requests[0].ready, mode + ": fixture did not exercise out-of-order synthesis");
        assert((await page.getByText("最后代回原式，检查等式是否成立。", { exact: false }).count()) > 0, mode + ": Chinese reveal incomplete");
        if (mode !== "free") { await pasteImage(); await send(); await idle(); }
        const turnPath = (mode === "exam" ? "/api/sessions/" : mode === "free" ? "/api/free-sessions/" : "/api/reading-sessions/") + ids[mode] + "/turn";
        assert(submissions.some((input) => input.path === turnPath && input.text === "" && input.imageCount === 1),
          mode + ": image-only input was not submitted");
        const layout = await fit(mode);
        await pasteImage();
        await fit(mode, true);
        await page.getByRole("button", { name: "移除图片 1", exact: true }).click();
        assert(await page.getByAltText("待发送图片 1", { exact: true }).count() === 0, mode + ": image removal failed");
        pass(mode + " parallel TTS, ordered reveal, shared composer and image paste", { peak: q.peak, requestCount: q.requests.length, layout });
        if (mode === "reading") {
          const saved = await api("/api/reading-sessions/" + ids.reading);
          const message = saved.messages.find((item) => item.role === "user" && item.attachmentCount === 1);
          assert(message && !JSON.stringify(saved).includes("data:image/"), "reading history sent raw image bodies");
          const image = await page.request.get(base + message.attachments[0]);
          assert(image.ok() && image.headers()["content-type"] === "image/jpeg", "reading saved image was not readable");
          const requests = await (await page.request.get(mock + "/requests")).json();
          assert(requests.some((request) => request.messages[0].content.includes("陪中国学生阅读") &&
            request.messages.some((entry) => Array.isArray(entry.content) && entry.content.includes("[image omitted]"))), "reading model did not receive an image part");
          await page.reload();
          await page.getByRole("button", { name: "进入阅读课堂", exact: true }).click();
          await page.getByAltText("问题图片 1", { exact: true }).first().waitFor();
          await page.getByRole("tab", { name: "练习", exact: true }).click();
          assert(await page.getByAltText("问题图片 1", { exact: true }).count() === 2, "reading practice did not restore the answer image");
          pass("reading image storage, lazy history, multimodal input and reload");
        }
      }
      return results;
    },
    async boundaries(stage = "duplicate") {
      if (stage === "duplicate") {
      await setModel("audit-shared-duplicate");
      await page.goto(base + "/free-classroom/" + ids.free);
      await send("检查重复语音");
      await page.waitForFunction(() => window.__voiceQa.ended.filter((clip) => clip.speech).length === 3);
      await idle();
      assert((await metrics()).requests.length === 2, "identical voice scripts were synthesized twice");
      pass("duplicate scripts reuse one synthesis result");
      }

      if (stage === "mute") {
      await setModel("audit-shared-voice");
      await page.goto(base + "/free-classroom/" + ids.free);
      await page.locator('button[title="静音"]').first().click();
      await send("静音后恢复预取");
      await page.getByText("正在讲解", { exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert((await metrics()).requests.length === 0, "muted mode requested TTS");
      await page.locator('button[title="开启日语语音"]').first().click();
      await idle();
      const resumed = await metrics();
      assert(resumed.requests.length > 0 && resumed.requests.length <= 2, "unmute replayed already revealed history");
      pass("mute skips synthesis and resumes only pending messages", { resumedRequests: resumed.requests.length });
      }

      if (stage === "cancel") {
      await setModel("audit-shared-cancel");
      await page.goto(base + "/free-classroom/" + ids.free); ttsMode = "slow";
      await send("检查打断");
      await page.waitForFunction(() => window.__voiceQa.requests.length === 3);
      await stopButton().click();
      await idle();
      await page.waitForFunction(() => window.__voiceQa.requests.every((request) => request.error === "AbortError"));
      pass("stop cancels all parallel synthesis without late playback");
      ttsMode = "normal";
      }

      if (stage === "fallback") {
      ttsMode = "failure";
      await setModel("audit-shared-voice");
      await page.goto(base + "/free-classroom/" + ids.free);
      await send("检查文字降级");
      await idle();
      const failed = await metrics();
      assert(failed.requests.some((request) => request.status === 503), "failure fixture was not exercised");
      assert(await page.getByText("最后代回原式，检查等式是否成立。", { exact: false }).count() > 0, "TTS failure blocked text or later messages");
      pass("one failed synthesis falls back to text and the turn completes");
      ttsMode = "normal";
      }

      if (stage === "input") {
      await setModel("audit-shared-voice");
      await page.goto(base + "/free-classroom/" + ids.free);
      await textbox().fill("保留草稿");
      await textbox().press("Shift+Enter");
      assert((await textbox().inputValue()).includes("\n"), "Shift+Enter submitted the draft");
      const beforeComposition = submissions.length;
      await textbox().dispatchEvent("compositionstart");
      await textbox().dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true });
      assert(submissions.length === beforeComposition, "IME composition submitted the draft");
      await textbox().dispatchEvent("compositionend", { data: "" });
      await textbox().dispatchEvent("keyup", { key: "Enter", keyCode: 229 });
      await pasteImage();
      await page.getByRole("button", { name: "请求提示", exact: true }).click(); await idle();
      assert((await textbox().inputValue()).startsWith("保留草稿") && await page.getByAltText("待发送图片 1").count() === 1, "hint discarded the staged draft");
      for (let count = 2; count <= 4; count++) await pasteImage(count);
      await textbox().click(); await page.keyboard.press("Control+V");
      await page.getByRole("alert").getByText("每条消息最多附加 4 张图片。", { exact: true }).waitFor();
      assert(await page.getByAltText(/^待发送图片/).count() === 4, "image cap silently dropped existing attachments");
      pass("keyboard, IME, draft preservation and image limit");
      }

      if (stage === "text") {
      await setModel("audit-shared-voice");
      await page.goto(base + "/free-classroom/" + ids.free);
      await textbox().click();
      await page.evaluate(() => navigator.clipboard.writeText("普通文本粘贴"));
      await page.keyboard.press("Control+V");
      assert(await textbox().inputValue() === "普通文本粘贴", "native text paste was intercepted");
      const response = page.waitForResponse((response) => response.url().endsWith("/turn") && response.request().postDataJSON().text === "普通文本粘贴", { timeout: 8000 });
      await textbox().press("Enter");
      await response; await idle();
      await page.locator('input[type="file"][multiple]').setInputFiles({ name: "answer.png", mimeType: "image/png", buffer: png });
      await page.getByAltText("待发送图片 1", { exact: true }).waitFor();
      assert(await page.locator('input[capture="environment"]').count() === 1, "camera input was lost");
      pass("native text paste, Enter send, image selection and camera control");
      }

      if (stage === "validation") {
      await page.goto(base + "/free-classroom/" + ids.free);
      const oversized = "字".repeat(4001);
      await api("/api/sessions/" + ids.exam + "/turn", "POST", { text: oversized }, 400);
      const free = await api("/api/free-sessions/" + ids.free);
      await api("/api/free-sessions/" + ids.free + "/turn", "POST", { text: oversized, requestId: randomUUID(), topicId: free.session.currentTopicId }, 400);
      await api("/api/reading-sessions/" + ids.reading + "/turn", "POST", { text: oversized, paragraphIdx: 0 }, 400);
      await api("/api/reading-sessions/" + ids.reading + "/turn", "POST", { images: Array(5).fill(dataUrl), paragraphIdx: 0 }, 400);
      await api("/api/reading-sessions/" + ids.reading + "/turn", "POST", { images: ["data:text/plain;base64,QQ=="], paragraphIdx: 0 }, 400);
      await api("/api/reading-sessions/" + ids.reading + "/turn", "POST", { text: "位置校验", paragraphIdx: 99 }, 409);
      pass("shared text/image validation and paragraph binding");

      await send("清理配音资源"); await idle();
      const owned = (await metrics()).created.filter((item) => item.speech).map((item) => item.url);
      const requestCount = (await metrics()).requests.length;
      await page.getByRole("link", { name: "返回自由提问", exact: true }).click();
      await page.waitForURL(base + "/free");
      await page.waitForFunction((urls) => urls.every((url) => window.__voiceQa.revoked.includes(url)), owned);
      const released = await metrics();
      assert(owned.every((url) => released.revoked.includes(url)), "classroom unmount leaked audio URLs");
      assert(released.requests.length === requestCount, "unmount started queued synthesis");
      pass("client navigation clears owned audio resources");
      }
      return results;
    },
    async previews() {
      await page.goto(base + "/settings");
      await page.getByRole("button", { name: "保存并试听", exact: true }).click();
      await page.getByText("设置已保存，语音合成成功，正在播放。", { exact: true }).waitFor();
      await page.getByRole("button", { name: "保存并试听", exact: true }).click();
      await page.waitForFunction(() => window.__voiceQa.requests.length === 2);
      assert((await metrics()).requests.every((request) => request.fresh), "settings preview reused old configuration audio");
      pass("settings previews always send fresh requests");
      await page.goto(base + "/tutors/" + ids.tutor);
      ttsMode = "slow";
      await page.getByRole("button", { name: "试听当前声音", exact: true }).click();
      await page.waitForFunction(() => window.__voiceQa.requests.length === 1);
      await page.getByRole("button", { name: "试听当前声音", exact: true }).click();
      await page.waitForFunction(() => window.__voiceQa.requests[0].error === "AbortError");
      ttsMode = "normal";
      await page.getByRole("button", { name: "试听当前声音", exact: true }).click();
      await page.waitForFunction(() => window.__voiceQa.ended.some((clip) => clip.speech));
      const beforeSample = (await metrics()).requests.length;
      await page.getByRole("button", { name: "搜索", exact: true }).click();
      await page.getByTitle("试听", { exact: true }).click();
      await page.waitForFunction(() => window.__voiceQa.ended.some((clip) => !clip.speech));
      assert((await metrics()).requests.length === beforeSample, "existing voice sample triggered synthesis");
      pass("tutor preview cancellation, retry and direct sample playback");
      await page.goto(base + "/papers/new");
      await page.locator('input[type="file"]').first().setInputFiles({ name: "audit.png", mimeType: "image/png", buffer: png });
      await page.getByText("已添加 1 页", { exact: true }).waitFor();
      await page.screenshot({ path: "output/playwright/shared-upload.png", scale: "css" });
      pass("paper image upload preview and settings smoke");
      return results;
    },
    async finish() {
      assert(pageErrors.length === 0, "browser error: " + pageErrors.join("; "));
      const summary = [...new Map(results.map((result) => [result.test, result])).values()];
      fs.writeFileSync("output/audit/voice-composer-results.json", JSON.stringify(summary, null, 2));
      return summary;
    },
    async runAll() {
      await this.seed();
      for (const mode of ["exam", "free", "reading"]) await this.classrooms([mode]);
      for (const stage of ["duplicate", "mute", "cancel", "fallback", "input", "text", "validation"]) await this.boundaries(stage);
      await this.previews();
      return this.finish();
    },
  };
};

export default runVoiceComposerAudit;
