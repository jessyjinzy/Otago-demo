import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createOtagoController, DEMO_PRESCRIPTION } from "./simplified-controller.mjs";
import { decodeVisionImage, sanitizeCaptureKind } from "./vision-storage.mjs";
import { attachXtyRealtimeRelay } from "./xty-realtime-relay.mjs";
import { createRealtimeSessionConfig, createRealtimeStateUpdate, resolveRealtimeProtocol } from "./realtime-protocol.mjs";

const rootDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(rootDir, "public");
const logDir = resolve(rootDir, "logs");
const imageLogDir = resolve(logDir, "images");
const gvhmrExtractor = resolve(rootDir, "scripts/extract_gvhmr_sequence.py");
const gvhmrScenarioRoot = resolve(rootDir, "motion_test_data");
const execFileAsync = promisify(execFile);
loadEnv(resolve(rootDir, ".env"));
const gvhmrOutputRoot = resolve(process.env.GVHMR_OUTPUT_ROOT || resolve(rootDir, ".."));

const port = Number(process.env.PORT || 3001);
const model = process.env.XTY_REALTIME_MODEL || "gpt-realtime";
const reasoningEffort = parseReasoningEffort(process.env.XTY_REALTIME_REASONING_EFFORT || "medium");
const OPENAI_REALTIME_VOICES = Object.freeze(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const defaultVoice = resolveOpenAIVoice(process.env.OPENAI_REALTIME_VOICE || "marin");
const transcriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe";
const truncationPostInstructions = parseBoundedInteger(process.env.OPENAI_REALTIME_HISTORY_TOKENS || "6000", 1000, 100000, "OPENAI_REALTIME_HISTORY_TOKENS");
const truncationRetentionRatio = parseBoundedNumber(process.env.OPENAI_REALTIME_RETENTION_RATIO || "0.8", 0.1, 1, "OPENAI_REALTIME_RETENTION_RATIO");
const xtyRealtimeWsUrl = process.env.XTY_REALTIME_WS_URL || "wss://svip.xty.app/v1/realtime";
const xtyApiKey = process.env.XTY_API_KEY || "";
const xtyRealtimeImageInput = /^(1|true|yes)$/i.test(process.env.XTY_REALTIME_IMAGE_INPUT || "true");
const realtimeProtocol = resolveRealtimeProtocol(model, process.env.XTY_REALTIME_PROTOCOL || "auto");
if (!/^wss:\/\//i.test(xtyRealtimeWsUrl)) throw new Error("XTY_REALTIME_WS_URL must use wss://.");
const sessions = new Map();
const sessionLifetimeMs = 4 * 60 * 60 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, provider: "XTY third-party relay", architecture: "simplified cursor + generic events", transport: "local WebSocket → XTY Realtime WebSocket", model, voice: defaultVoice, default_voice: defaultVoice, supported_voices: OPENAI_REALTIME_VOICES, reasoning_effort: realtimeProtocol === "modern" ? reasoningEffort : "unsupported_by_legacy_protocol", realtime_protocol: realtimeProtocol,
        history_token_limit: truncationPostInstructions, retention_ratio: truncationRetentionRatio,
        endpoint: xtyRealtimeWsUrl, api_key_configured: Boolean(xtyApiKey), realtime_image_input_supported: xtyRealtimeImageInput });
    }
    if (req.method === "GET" && url.pathname === "/api/demo-prescription") return sendJson(res, 200, DEMO_PRESCRIPTION);
    if (req.method === "GET" && url.pathname === "/api/gvhmr/sequences") {
      const result = await runGvhmrExtractor(["--list"]);
      return sendJson(res, 200, { ...result, source_root: gvhmrOutputRoot });
    }
    if (req.method === "POST" && url.pathname === "/api/gvhmr/extract") {
      const body = await readJson(req);
      const sequenceId = String(body.sequence_id || "");
      if (!/^(?:output[12]|motion_test_data)\/[a-zA-Z0-9_.-]+$/.test(sequenceId)) return sendJson(res, 400, { error: "Invalid sequence_id." });
      const startSeconds = parseBoundedNumber(body.start_seconds ?? 0, 0, 3600, "start_seconds");
      const endSeconds = parseBoundedNumber(body.end_seconds ?? 20, startSeconds + 0.1, 3600, "end_seconds");
      const analysisFps = parseBoundedNumber(body.analysis_fps ?? 5, 1, 10, "analysis_fps");
      const dataset = await runGvhmrExtractor([
        "--sequence-id", sequenceId,
        "--start-s", String(startSeconds),
        "--end-s", String(endSeconds),
        "--analysis-fps", String(analysisFps),
      ]);
      return sendJson(res, 200, dataset);
    }

    if (req.method === "POST" && url.pathname === "/api/realtime/session") return sendJson(res, 410, { error: "Use the local /api/realtime/ws XTY relay." });

    const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)(?:\/(tool-call|motion-event|prescription|auto-route|client-event|vision-capture|end))?$/i);
    if (match) {
      const record = sessions.get(match[1]);
      if (!record) return sendJson(res, 404, { error: "Local session not found or expired." });
      record.touchedAt = Date.now();
      if (req.method === "GET" && !match[2]) return sendJson(res, 200, sessionPayload(record.coach));
      if (req.method === "POST" && match[2] === "tool-call") return executeToolCall(req, res, record);
      if (req.method === "POST" && match[2] === "motion-event") return applyMotionEvent(req, res, record);
      if (req.method === "POST" && match[2] === "prescription") return updatePrescription(req, res, record.coach);
      if (req.method === "POST" && match[2] === "auto-route") return autoRoute(req, res, record);
      if (req.method === "POST" && match[2] === "client-event") return recordClientEvent(req, res, record);
      if (req.method === "POST" && match[2] === "vision-capture") return saveVisionCapture(req, res, record, match[1]);
      if (req.method === "POST" && match[2] === "end") return endSession(req, res, record);
    }

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(url.pathname, req.method === "HEAD", res);
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

attachXtyRealtimeRelay({
  server,
  endpoint: xtyRealtimeWsUrl,
  model,
  apiKey: xtyApiKey,
  createSession: createLocalRealtimeSession,
  createSessionConfig: createRealtimeConfig,
  resolveVoice: resolveOpenAIVoice,
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Otago XTY Realtime Coach: http://localhost:${port}`);
  console.log(`XTY Realtime endpoint: ${xtyRealtimeWsUrl}?model=${encodeURIComponent(model)}`);
  if (!xtyApiKey) console.log("XTY_API_KEY is missing. Add the third-party key to .env.");
});

setInterval(() => {
  const expiredBefore = Date.now() - sessionLifetimeMs;
  for (const [id, record] of sessions) if (record.touchedAt < expiredBefore) sessions.delete(id);
}, 15 * 60 * 1000).unref();

function createLocalRealtimeSession({ voice = defaultVoice } = {}) {
  const localSessionId = randomUUID();
  const coach = createOtagoController();
  const record = { coach, voice, createdAt: Date.now(), touchedAt: Date.now(), toolCalls: [], clientEvents: [], visionCaptures: [], conversation: [], logPath: null };
  sessions.set(localSessionId, record);
  return { id: localSessionId, coach, touch: () => { record.touchedAt = Date.now(); } };
}

async function executeToolCall(req, res, record) {
  const body = await readJson(req);
  const coach = record.coach;
  const before = coach.snapshot();
  const result = coach.execute(String(body.name || ""), body.arguments && typeof body.arguments === "object" ? body.arguments : {});
  record.toolCalls.push({ at: new Date().toISOString(), name: String(body.name || ""), arguments: body.arguments || {}, result: { ok: result.ok, current_state: result.current_state, reason: result.reason, error: result.error } });
  if (body.name === "submit_session_event" && body.arguments?.event === "new_session_requested" && result.ok) persistSessionLog(record, "new_session_requested", before);
  if (body.name === "finalize_session" && result.ok && result.finalized) persistSessionLog(record, "agent_completed");
  return sendJson(res, 200, { result, ...sessionPayload(coach) });
}

async function applyMotionEvent(req, res, record) {
  const body = await readJson(req);
  const event = body.event && typeof body.event === "object" ? body.event : body;
  const result = record.coach.recordMotionEvent(event);
  record.toolCalls.push({
    at: new Date().toISOString(), name: "record_motion_event", source: "motion_interface",
    arguments: {
      exercise_id: event.exercise?.id,
      status: event.assessment?.status,
      valid_count_increment: event.observation?.valid_count_increment,
    },
    result: { ok: result.ok, current_state: result.current_state, reason: result.reason, error: result.error, motion_progress: result.motion_progress },
  });
  return sendJson(res, result.ok ? 200 : 409, { result, ...sessionPayload(record.coach) });
}

async function updatePrescription(req, res, coach) {
  const body = await readJson(req);
  const result = coach.setPrescription(body.prescription || body);
  return sendJson(res, result.ok ? 200 : 400, { result, ...sessionPayload(coach) });
}

async function autoRoute(req, res, record) {
  await readJson(req);
  const result = record.coach.autoRouteFromRest();
  record.toolCalls.push({ at: new Date().toISOString(), name: "route_from_rest", source: "controller_auto", result: { ok: result.ok, current_state: result.current_state, reason: result.reason, error: result.error } });
  return sendJson(res, 200, { result, ...sessionPayload(record.coach) });
}

async function recordClientEvent(req, res, record) {
  const body = await readJson(req);
  const allowedKinds = new Set(["data_channel_sent", "state_advance_requested", "realtime_event", "function_call_received", "vision_capture"]);
  const kind = allowedKinds.has(body.kind) ? body.kind : "unknown";
  record.clientEvents.push({ at: new Date().toISOString(), kind, detail: body.detail && typeof body.detail === "object" ? body.detail : {} });
  if (record.clientEvents.length > 1000) record.clientEvents.splice(0, record.clientEvents.length - 1000);
  return sendJson(res, 200, { ok: true });
}

async function saveVisionCapture(req, res, record, sessionId) {
  const body = await readJson(req, 8_000_000);
  const decoded = decodeVisionImage(body.image_data);
  const kind = sanitizeCaptureKind(body.kind);
  const sessionDir = resolve(imageLogDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const sequence = record.visionCaptures.length + 1;
  const filename = `${String(sequence).padStart(3, "0")}-${Date.now()}-${kind}${decoded.extension}`;
  const file = resolve(sessionDir, filename);
  writeFileSync(file, decoded.bytes);
  const relativePath = `logs/images/${sessionId}/${filename}`;
  const metadata = {
    at: new Date().toISOString(), kind, state: String(body.state || record.coach.snapshot().current_state),
    width: Number(body.width) || null, height: Number(body.height) || null,
    mime_type: decoded.mimeType, bytes: decoded.bytes.length, filename, relative_path: relativePath,
    context: body.context && typeof body.context === "object" ? body.context : {},
  };
  record.visionCaptures.push(metadata);
  return sendJson(res, 200, { ok: true, filename, relative_path: relativePath, metadata });
}

async function endSession(req, res, record) {
  const body = await readJson(req);
  if (Array.isArray(body.conversation)) record.conversation = body.conversation.slice(-500);
  const logPath = persistSessionLog(record, String(body.reason || "browser_ended_session"));
  return sendJson(res, 200, { ok: true, log_path: logPath, ...sessionPayload(record.coach) });
}

function createRealtimeConfig(coach, { voice = defaultVoice } = {}) {
  return createRealtimeSessionConfig({
    protocol: realtimeProtocol, model, instructions: coach.getInstructions(), tools: coach.getTools(),
    voice, transcriptionModel, reasoningEffort, truncation: realtimeTruncation(), maxOutputTokens: 800,
  });
}

function resolveOpenAIVoice(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return OPENAI_REALTIME_VOICES.includes(candidate) ? candidate : "marin";
}

function sessionPayload(coach) {
  return {
    snapshot: coach.snapshot(),
    session_update: {
      type: "session.update",
      session: createRealtimeStateUpdate({ protocol: realtimeProtocol, model, instructions: coach.getInstructions(), tools: coach.getTools(), truncation: realtimeTruncation() }),
    },
  };
}

function realtimeTruncation() {
  return { type: "retention_ratio", retention_ratio: truncationRetentionRatio, token_limits: { post_instructions: truncationPostInstructions } };
}

function parseBoundedInteger(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  return number;
}

function parseReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (!["low", "medium", "high"].includes(effort)) throw new Error("XTY_REALTIME_REASONING_EFFORT must be low, medium, or high.");
  return effort;
}

function parseBoundedNumber(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return number;
}

async function runGvhmrExtractor(argumentsList) {
  if (!existsSync(gvhmrExtractor)) throw new Error("GVHMR extraction helper is missing.");
  const { stdout } = await execFileAsync("python3", [gvhmrExtractor, "--source-root", gvhmrOutputRoot, "--scenario-root", gvhmrScenarioRoot, ...argumentsList], {
    maxBuffer: 24 * 1024 * 1024,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

function persistSessionLog(record, reason, snapshotOverride) {
  mkdirSync(logDir, { recursive: true });
  const snapshot = snapshotOverride || record.coach.snapshot();
  const filename = `${snapshot.prescription_id.replace(/[^a-z0-9_-]+/gi, "-")}-${snapshot.run_number || 1}-${Date.now()}.json`;
  const file = resolve(logDir, filename);
  const value = {
    schema_version: "1.0", logged_at: new Date().toISOString(), reason,
    session_started_at: new Date(record.createdAt).toISOString(), voice: record.voice, snapshot,
    tool_calls: record.toolCalls, client_events: record.clientEvents, vision_captures: record.visionCaptures, conversation: record.conversation,
    privacy_note: "Local research demo log. With explicit demo approval, original vision JPEG/PNG files are retained under logs/images/ for this run. Do not use direct identifiers or commit logs to source control.",
  };
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  record.logPath = file;
  return file;
}

function serveStatic(pathname, headOnly, res) {
  const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const candidate = normalize(resolve(publicDir, `.${requested}`));
  if (!(candidate === publicDir || candidate.startsWith(publicDir + sep))) return sendJson(res, 403, { error: "Forbidden" });
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return sendJson(res, 404, { error: "Not found" });
  const content = readFileSync(candidate);
  res.writeHead(200, { "Content-Type": mimeTypes[extname(candidate)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(headOnly ? undefined : content);
}

async function readJson(req, limit = 2_000_000) {
  const text = await readBody(req, limit);
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error("Request body must be valid JSON."); }
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (chunk) => { size += chunk.length; if (size > limit) { reject(new Error("Request body is too large.")); req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim(); if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("="); if (index < 1) continue;
    const key = line.slice(0, index).trim(); let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
