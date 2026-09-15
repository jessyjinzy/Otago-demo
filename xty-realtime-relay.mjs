import { WebSocket, WebSocketServer } from "ws";

export function attachXtyRealtimeRelay({
  server,
  path = "/api/realtime/ws",
  endpoint,
  model,
  apiKey,
  createSession,
  createSessionConfig,
  resolveVoice,
}) {
  const relay = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });

  server.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try { pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname; } catch { /* rejected below */ }
    if (pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    relay.handleUpgrade(request, socket, head, (browserSocket) => relay.emit("connection", browserSocket, request));
  });

  relay.on("connection", (browserSocket, request) => {
    if (!apiKey) {
      sendRelayEvent(browserSocket, "otago.relay.error", {
        code: "missing_xty_api_key",
        message: "XTY_API_KEY is not configured in .env.",
      });
      browserSocket.close(1008, "XTY key missing");
      return;
    }

    const requestUrl = new URL(request.url || path, `http://${request.headers.host || "localhost"}`);
    const voice = resolveVoice?.(requestUrl.searchParams.get("voice")) || "marin";
    const local = createSession({ voice });
    const upstreamUrl = new URL(endpoint);
    upstreamUrl.searchParams.set("model", model);
    const upstream = new WebSocket(upstreamUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    let upstreamReady = false;
    let browserClosed = false;

    sendRelayEvent(browserSocket, "otago.session.created", {
      local_session_id: local.id,
      model,
      voice,
      provider: "XTY",
    });

    upstream.on("open", () => {
      upstreamReady = true;
      upstream.send(JSON.stringify({ type: "session.update", session: createSessionConfig(local.coach, { voice }) }));
      sendRelayEvent(browserSocket, "otago.relay.ready", {
        local_session_id: local.id,
        model,
        voice,
      });
    });

    upstream.on("message", (data, isBinary) => {
      if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(data, { binary: isBinary });
    });

    upstream.on("unexpected-response", (_request, response) => {
      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        if (received >= 16_384) return;
        chunks.push(chunk);
        received += chunk.length;
      });
      response.on("end", () => {
        const detail = redactProviderError(Buffer.concat(chunks).toString("utf8"));
        sendRelayEvent(browserSocket, "otago.relay.error", {
          code: "xty_handshake_failed",
          message: `XTY Realtime handshake failed (${response.statusCode}): ${detail}`,
        });
      });
    });

    upstream.on("error", (error) => {
      sendRelayEvent(browserSocket, "otago.relay.error", {
        code: "xty_upstream_error",
        message: `XTY Realtime upstream error: ${error.message}`,
      });
    });

    upstream.on("close", (code, reason) => {
      if (browserClosed) return;
      sendRelayEvent(browserSocket, "otago.relay.error", {
        code: "xty_upstream_closed",
        message: `XTY Realtime upstream closed (${code}): ${reason.toString() || "no reason"}`,
      });
    });

    browserSocket.on("message", (data, isBinary) => {
      local.touch?.();
      if (!upstreamReady || upstream.readyState !== WebSocket.OPEN) {
        sendRelayEvent(browserSocket, "otago.relay.error", {
          code: "xty_upstream_not_ready",
          message: "XTY Realtime upstream is not ready.",
        });
        return;
      }
      upstream.send(data, { binary: isBinary });
    });

    browserSocket.on("close", () => {
      browserClosed = true;
      if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(upstream.readyState)) upstream.close(1000, "Browser relay closed");
    });

    browserSocket.on("error", () => {
      browserClosed = true;
      if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(upstream.readyState)) upstream.close(1011, "Browser relay error");
    });
  });

  return relay;
}

function sendRelayEvent(socket, type, detail) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, ...detail }));
}

function redactProviderError(value) {
  return String(value || "empty response")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer ***")
    .slice(0, 2_000);
}
