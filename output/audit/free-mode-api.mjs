import assert from "node:assert/strict";

const base = "http://127.0.0.1:3107";
const json = async (path, init) => {
  const response = await fetch(base + path, init);
  const value = await response.json().catch(() => null);
  return { response, value };
};
const post = (path, body) => json(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const postStream = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const events = async (result) => {
  const response = result.response ?? result;
  if (response.status !== 200) {
    const body = await response.text();
    assert.equal(response.status, 200, "expected stream, got " + response.status + ": " + body);
  }
  const text = await response.text();
  return text.trim().split("\n").map((line) => JSON.parse(line));
};
const report = [];

const tutorResult = await json("/api/tutors");
const tutors = tutorResult.value;
assert.ok(Array.isArray(tutors) && tutors.length > 0);
const connection = { id: "audit-free", name: "Free mode mock", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:4107/v1", apiKey: "audit-dummy-key", proxyUrl: "http://proxy-audit-user:proxy-audit-password@127.0.0.1:18081" };
const configured = await json("/api/settings", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ connections: [connection], models: { chat: { connectionId: connection.id, model: "audit-free" }, analysis: { connectionId: connection.id, model: "audit-free" } }, autoContinue: false }),
});
assert.equal(configured.response.status, 200);
report.push("chat-only configuration creates free sessions without Fish Audio credentials");
const publicConnection = configured.value.connections.find((item) => item.id === connection.id);
assert.equal(publicConnection.hasProxy, true);
assert.equal(publicConnection.proxyPreview, "http://***@127.0.0.1:18081");
assert.equal("proxyUrl" in publicConnection, false);
assert.doesNotMatch(JSON.stringify(configured.value), /proxy-audit-user|proxy-audit-password/);
let proxySettings = (await json("/api/settings")).value;
let preservedProxy = await json("/api/settings", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ connections: proxySettings.connections.map((item) => ({ ...item, apiKey: item.id === connection.id ? "audit-dummy-key" : null })), models: proxySettings.models }),
});
assert.equal(preservedProxy.value.connections.find((item) => item.id === connection.id).hasProxy, true);
proxySettings = (await json("/api/settings")).value;
const clearedProxy = await json("/api/settings", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ connections: proxySettings.connections.map((item) => ({ ...item, apiKey: item.id === connection.id ? "audit-dummy-key" : null, ...(item.id === connection.id ? { proxyUrl: null } : {}) })), models: proxySettings.models }),
});
assert.equal(clearedProxy.value.connections.find((item) => item.id === connection.id).hasProxy, false);
report.push("connection proxy credentials are redacted, omitted updates preserve them, and null clears them");
const setChatModel = async (model) => {
  const current = (await json("/api/settings")).value;
  const result = await json("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connections: current.connections.map((item) => ({ ...item, apiKey: item.id === connection.id ? "audit-dummy-key" : null })), models: { ...current.models, chat: { ...current.models.chat, model } } }) });
  assert.equal(result.response.status, 200);
};

const createId = "free-create-" + crypto.randomUUID();
const created = await post("/api/free-sessions", { tutorId: tutors[0].id, requestId: createId });
assert.equal(created.response.status, 201);
const duplicate = await post("/api/free-sessions", { tutorId: tutors[0].id, requestId: createId });
assert.equal(duplicate.value.id, created.value.id);
const collision = await post("/api/free-sessions", { tutorId: tutors[1].id, requestId: createId });
assert.equal(collision.response.status, 409);
const sessionId = created.value.id;
report.push("create request is idempotent and rejects reuse for another tutor");

const getTurn = (requestId, body) => postStream("/api/free-sessions/" + sessionId + "/turn", { requestId, ...body });
const welcomeId = (await json("/api/free-sessions/" + sessionId)).value.session.welcomeRequestId;
const welcome = await events(await getTurn(welcomeId, { intent: "greeting" }));
assert.deepEqual(welcome.map((event) => event.type), ["message", "done"]);
const welcomeReplay = await events(await getTurn(welcomeId, { intent: "greeting" }));
assert.deepEqual(welcomeReplay.map((event) => event.type), ["message", "done"]);
let state = (await json("/api/free-sessions/" + sessionId)).value;
assert.equal(state.topics.length, 0);
assert.equal(state.messages.filter((message) => message.turnId === state.moreTurns[0].id && message.kind === "board").length, 0);
report.push("welcome replays after refresh without topic or board changes");

const firstRequest = "free-turn-" + crypto.randomUUID();
const first = await events(await getTurn(firstRequest, { text: "为什么负数乘负数会变成正数？", topicId: null }));
assert.equal(first.at(-1).type, "done");
assert.equal(first.filter((event) => event.type === "topic").length, 1);
state = (await json("/api/free-sessions/" + sessionId)).value;
assert.equal(state.topics.length, 1);
const firstTopic = state.session.currentTopicId;
const messageCountAfterFirst = state.messages.length;
await events(await getTurn(firstRequest, { text: "为什么负数乘负数会变成正数？", topicId: null }));
state = (await json("/api/free-sessions/" + sessionId)).value;
assert.equal(state.messages.length, messageCountAfterFirst);
report.push("first question creates one topic and successful retry only replays saved events");

const followupRequest = "free-turn-" + crypto.randomUUID();
const followup = await events(await getTurn(followupRequest, { text: "可以再用数轴解释吗？", topicId: firstTopic }));
assert.equal(followup.filter((event) => event.type === "topic").length, 0);
state = (await json("/api/free-sessions/" + sessionId)).value;
assert.equal(state.topics.length, 1);

const secondRequest = "free-turn-" + crypto.randomUUID();
await events(await getTurn(secondRequest, { text: "换话题，讲讲勾股定理", topicId: firstTopic }));
state = (await json("/api/free-sessions/" + sessionId)).value;
assert.equal(state.topics.length, 2);
const secondTopic = state.session.currentTopicId;
assert.notEqual(firstTopic, secondTopic);
report.push("follow-up keeps its board and explicit topic change creates a page");

const oldTopic = await json("/api/free-sessions/" + sessionId + "/topics/" + firstTopic);
assert.equal(oldTopic.value.blocks.length, 2);
const switched = await json("/api/free-sessions/" + sessionId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentTopicId: firstTopic }) });
assert.equal(switched.value.currentTopicId, firstTopic);
const continued = await events(await getTurn("free-turn-" + crypto.randomUUID(), { intent: "continue", topicId: firstTopic }));
assert.equal(continued.at(-1).action, "wait");

const image = "data:image/jpeg;base64," + Buffer.from("audit-image").toString("base64");
const imageTurnId = "free-turn-" + crypto.randomUUID();
await events(await getTurn(imageTurnId, { text: "请看图。", images: [image], topicId: firstTopic }));
state = (await json("/api/free-sessions/" + sessionId)).value;
const imageMessage = state.messages.find((message) => message.role === "user" && message.content === "请看图。");
assert.equal(imageMessage.attachmentCount, 1);
assert.ok(imageMessage.attachments[0].startsWith("/api/free-sessions/"));
assert.ok(!JSON.stringify(state.messages).includes("data:image/jpeg"));
const attachment = await fetch(base + imageMessage.attachments[0]);
assert.equal(attachment.headers.get("content-type"), "image/jpeg");
assert.equal(Buffer.from(await attachment.arrayBuffer()).toString(), "audit-image");
report.push("images are stored privately and served through a lazy scoped attachment URL");

const renamed = await json("/api/free-sessions/" + sessionId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "复习代数" }) });
assert.equal(renamed.value.title, "复习代数");
const notes = await fetch(base + "/api/free-sessions/" + sessionId + "/notes");
assert.equal(notes.status, 200);
assert.match(await notes.text(), /## /);
const goodbye = await events(await getTurn("free-turn-" + crypto.randomUUID(), { intent: "goodbye", topicId: firstTopic }));
assert.deepEqual(goodbye.map((event) => event.type), ["message", "done"]);
state = (await json("/api/free-sessions/" + sessionId)).value;
assert.equal(state.topics.length, 2);
report.push("rename, Markdown notes and no-board goodbye work");

const removed = await json("/api/free-sessions/" + sessionId, { method: "DELETE" });
assert.equal(removed.response.status, 200);
const missing = await json("/api/free-sessions/" + sessionId);
assert.equal(missing.response.status, 404);
report.push("delete removes the free session and its dependent records");

const recoverySession = await post("/api/free-sessions", { tutorId: tutors[0].id, requestId: "free-create-" + crypto.randomUUID() });
const recoverySessionId = recoverySession.value.id;
const recoveryWelcome = (await json("/api/free-sessions/" + recoverySessionId)).value.session.welcomeRequestId;
await events(await postStream("/api/free-sessions/" + recoverySessionId + "/turn", { requestId: recoveryWelcome, intent: "greeting" }));
await events(await postStream("/api/free-sessions/" + recoverySessionId + "/turn", { requestId: "free-turn-" + crypto.randomUUID(), text: "开始讨论一个概念", topicId: null }));
let recovery = (await json("/api/free-sessions/" + recoverySessionId)).value;
const originalTopicId = recovery.session.currentTopicId;
await events(await postStream("/api/free-sessions/" + recoverySessionId + "/turn", { requestId: "free-turn-" + crypto.randomUUID(), text: "换话题，谈谈函数", topicId: originalTopicId }));
recovery = (await json("/api/free-sessions/" + recoverySessionId)).value;
const requestedTopicId = recovery.session.currentTopicId;
assert.notEqual(originalTopicId, requestedTopicId);
await setChatModel("audit-free-fail");
const recoveryRequestId = "free-turn-" + crypto.randomUUID();
const interrupted = await events(await postStream("/api/free-sessions/" + recoverySessionId + "/turn", { requestId: recoveryRequestId, text: "说明这个概念", topicId: requestedTopicId }));
assert.equal(interrupted.at(-1).type, "error");
assert.equal(interrupted.at(-1).code, "LLM_UPSTREAM_ERROR");
assert.match(interrupted.at(-1).error, /模型服务/);
recovery = (await json("/api/free-sessions/" + recoverySessionId)).value;
assert.equal(recovery.topics.length, 2);
const pinnedTopicId = recovery.session.currentTopicId;
assert.ok(recovery.messages.filter((message) => message.role === "user" && message.content === "说明这个概念").length === 1);
await json("/api/free-sessions/" + recoverySessionId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentTopicId: originalTopicId }) });
const staleRetry = await postStream("/api/free-sessions/" + recoverySessionId + "/turn", { requestId: recoveryRequestId, text: "说明这个概念", topicId: requestedTopicId });
assert.equal(staleRetry.status, 409);
await json("/api/free-sessions/" + recoverySessionId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentTopicId: pinnedTopicId }) });
await setChatModel("audit-free");
const resumed = await events(await postStream("/api/free-sessions/" + recoverySessionId + "/turn", { requestId: recoveryRequestId, text: "说明这个概念", topicId: requestedTopicId }));
assert.equal(resumed.at(-1).type, "done");
recovery = (await json("/api/free-sessions/" + recoverySessionId)).value;
assert.equal(recovery.topics.length, 2);
assert.equal(recovery.messages.filter((message) => message.role === "user" && message.content === "说明这个概念").length, 1);
assert.ok(recovery.messages.some((message) => message.role === "tutor" && message.kind === "board"));
report.push("partial turn keeps its assigned topic, reports stale selection, and retries without a duplicate user message or page");
await json("/api/free-sessions/" + recoverySessionId, { method: "DELETE" });

const preTopicSession = await post("/api/free-sessions", { tutorId: tutors[0].id, requestId: "free-create-" + crypto.randomUUID() });
const preTopicSessionId = preTopicSession.value.id;
const preTopicWelcome = (await json("/api/free-sessions/" + preTopicSessionId)).value.session.welcomeRequestId;
await events(await postStream("/api/free-sessions/" + preTopicSessionId + "/turn", { requestId: preTopicWelcome, intent: "greeting" }));
await events(await postStream("/api/free-sessions/" + preTopicSessionId + "/turn", { requestId: "free-turn-" + crypto.randomUUID(), text: "先讨论方程", topicId: null }));
let preTopicState = (await json("/api/free-sessions/" + preTopicSessionId)).value;
const firstSavedTopic = preTopicState.session.currentTopicId;
await events(await postStream("/api/free-sessions/" + preTopicSessionId + "/turn", { requestId: "free-turn-" + crypto.randomUUID(), text: "换话题，讨论几何", topicId: firstSavedTopic }));
preTopicState = (await json("/api/free-sessions/" + preTopicSessionId)).value;
const secondSavedTopic = preTopicState.session.currentTopicId;
await json("/api/free-sessions/" + preTopicSessionId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentTopicId: firstSavedTopic }) });
await setChatModel("audit-free-pretopic-fail");
const preTopicRequestId = "free-turn-" + crypto.randomUUID();
const failedBeforeTopic = await events(await postStream("/api/free-sessions/" + preTopicSessionId + "/turn", { requestId: preTopicRequestId, text: "请解释这个定理", topicId: firstSavedTopic }));
assert.equal(failedBeforeTopic.at(-1).type, "error");
await json("/api/free-sessions/" + preTopicSessionId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentTopicId: secondSavedTopic }) });
const changedTopicRetry = await postStream("/api/free-sessions/" + preTopicSessionId + "/turn", { requestId: preTopicRequestId, text: "请解释这个定理", topicId: firstSavedTopic });
assert.equal(changedTopicRetry.status, 409);
await json("/api/free-sessions/" + preTopicSessionId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentTopicId: firstSavedTopic }) });
await setChatModel("audit-free");
const preTopicResumed = await events(await postStream("/api/free-sessions/" + preTopicSessionId + "/turn", { requestId: preTopicRequestId, text: "请解释这个定理", topicId: firstSavedTopic }));
assert.equal(preTopicResumed.at(-1).type, "done");
preTopicState = (await json("/api/free-sessions/" + preTopicSessionId)).value;
assert.equal(preTopicState.topics.length, 2);
assert.equal(preTopicState.messages.filter((message) => message.role === "user" && message.content === "请解释这个定理").length, 1);
assert.ok(preTopicState.messages.some((message) => message.role === "user" && message.content === "请解释这个定理" && message.topicId === firstSavedTopic));
report.push("retry before topic selection stays bound to its original topic and survives a topic switch");
await json("/api/free-sessions/" + preTopicSessionId, { method: "DELETE" });

const emptyTopicSession = await post("/api/free-sessions", { tutorId: tutors[0].id, requestId: "free-create-" + crypto.randomUUID() });
const emptyTopicSessionId = emptyTopicSession.value.id;
const emptyTopicWelcome = (await json("/api/free-sessions/" + emptyTopicSessionId)).value.session.welcomeRequestId;
await events(await postStream("/api/free-sessions/" + emptyTopicSessionId + "/turn", { requestId: emptyTopicWelcome, intent: "greeting" }));
await setChatModel("audit-free-pretopic-fail");
const emptyTopicRequestId = "free-turn-" + crypto.randomUUID();
const failedWithoutTopic = await events(await postStream("/api/free-sessions/" + emptyTopicSessionId + "/turn", {
  requestId: emptyTopicRequestId, text: "请解释勾股定理", topicId: null,
}));
assert.equal(failedWithoutTopic.at(-1).type, "error");
let emptyTopicState = (await json("/api/free-sessions/" + emptyTopicSessionId)).value;
assert.equal(emptyTopicState.topics.length, 0);
assert.equal(emptyTopicState.messages.filter((message) => message.role === "user" && message.content === "请解释勾股定理").length, 1);
const failedEmptyTopicTurn = emptyTopicState.moreTurns.find((turn) => turn.requestId === emptyTopicRequestId);
assert.equal(emptyTopicState.messages.filter((message) => message.turnId === failedEmptyTopicTurn.id && message.role === "tutor").length, 0);
await setChatModel("audit-free");
const resumedWithoutTopic = await events(await postStream("/api/free-sessions/" + emptyTopicSessionId + "/turn", {
  requestId: emptyTopicRequestId, text: "请解释勾股定理", topicId: null,
}));
assert.equal(resumedWithoutTopic.at(-1).type, "done");
assert.equal(resumedWithoutTopic.filter((event) => event.type === "topic").length, 1);
emptyTopicState = (await json("/api/free-sessions/" + emptyTopicSessionId)).value;
assert.equal(emptyTopicState.topics.length, 1);
assert.equal(emptyTopicState.messages.filter((message) => message.role === "user" && message.content === "请解释勾股定理").length, 1);
assert.equal(emptyTopicState.messages.filter((message) => message.role === "user" && message.content === "请解释勾股定理")[0].topicId, emptyTopicState.topics[0].id);
report.push("a first turn that fails before topic creation retries once with the same request and creates one topic");
await json("/api/free-sessions/" + emptyTopicSessionId, { method: "DELETE" });

console.log(JSON.stringify({ result: "pass", checks: report }, null, 2));
