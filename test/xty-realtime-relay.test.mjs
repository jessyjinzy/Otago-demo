import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { attachXtyRealtimeRelay } from "../xty-realtime-relay.mjs";

test("relays Realtime events while keeping provider authentication on the server", async (context) => {
  const upstreamHttp = createServer();
  const upstreamWs = new WebSocketServer({ server: upstreamHttp });
  upstreamHttp.listen(0, "127.0.0.1");
  await once(upstreamHttp, "listening");
  const upstreamPort = upstreamHttp.address().port;

  let upstreamRequest;
  const upstreamMessages = [];
  upstreamWs.on("connection", (socket, request) => {
    upstreamRequest = request;
    socket.on("message", (data) => upstreamMessages.push(JSON.parse(data.toString())));
    socket.send(JSON.stringify({ type: "session.created", session: { id: "upstream" } }));
  });

  const localHttp = createServer((_request, response) => response.end("ok"));
  attachXtyRealtimeRelay({
    server: localHttp,
    endpoint: `ws://127.0.0.1:${upstreamPort}/v1/realtime`,
    model: "gpt-realtime",
    apiKey: "test-only-key",
    createSession: () => ({ id: "local-session", coach: {}, touch() {} }),
    createSessionConfig: () => ({ type: "realtime", instructions: "test", reasoning: { effort: "medium" } }),
  });
  localHttp.listen(0, "127.0.0.1");
  await once(localHttp, "listening");
  const localPort = localHttp.address().port;

  const browser = new WebSocket(`ws://127.0.0.1:${localPort}/api/realtime/ws`);
  const browserEvents = [];
  browser.on("message", (data) => browserEvents.push(JSON.parse(data.toString())));
  await waitUntil(() => browserEvents.some((event) => event.type === "otago.relay.ready"));
  await waitUntil(() => upstreamMessages.some((event) => event.type === "session.update"));

  assert.equal(upstreamRequest.headers.authorization, "Bearer test-only-key");
  assert.equal(new URL(upstreamRequest.url, "ws://localhost").searchParams.get("model"), "gpt-realtime");
  assert.ok(browserEvents.some((event) => event.type === "otago.session.created" && event.local_session_id === "local-session"));
  assert.deepEqual(upstreamMessages[0], { type: "session.update", session: { type: "realtime", instructions: "test", reasoning: { effort: "medium" } } });

  browser.send(JSON.stringify({ type: "response.create" }));
  await waitUntil(() => upstreamMessages.some((event) => event.type === "response.create"));

  context.after(() => {
    browser.close();
    upstreamWs.close();
    upstreamHttp.close();
    localHttp.close();
  });
});

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for relay event.");
}
