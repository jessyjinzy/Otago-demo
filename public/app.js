import { normalizeMotionEvent, validateMotionEvent } from "./motion-schema.js";
import { assessPixelData } from "./frame-quality.js";
import { XtyRealtimeAudioTransport } from "./xty-realtime-audio.js";
import { createRealtimeResponseConfig } from "./realtime-response.js";
import { GvhmrReplayEngine } from "./gvhmr-motion.js";
import { buildContinuityInstruction } from "./conversation-continuity.js";

const elements = {
  start: document.querySelector("#start-session"), stop: document.querySelector("#stop-session"),
  status: document.querySelector("#connection-status"), coachState: document.querySelector("#coach-state"),
  stateBanner: document.querySelector("#current-state-banner"), stateDetail: document.querySelector("#current-state-detail"),
  coachingStyle: document.querySelector("#coaching-style"),
  voice: document.querySelector("#realtime-voice"), voiceHint: document.querySelector("#voice-hint"),
  cameraStatus: document.querySelector("#camera-status"), cameraPreview: document.querySelector("#camera-preview"),
  cameraDevice: document.querySelector("#camera-device"), reconnectCamera: document.querySelector("#reconnect-camera"),
  cameraDiagnostics: document.querySelector("#camera-diagnostics"),
  lastCapture: document.querySelector("#last-capture"), lastCaptureCaption: document.querySelector("#last-capture-caption"),
  prescriptionStatus: document.querySelector("#prescription-status"), audio: document.querySelector("#remote-audio"),
  newSession: document.querySelector("#new-session"), pausePresentation: document.querySelector("#pause-presentation"),
  transcript: document.querySelector("#transcript"), eventLog: document.querySelector("#event-log"),
  sample: document.querySelector("#sample-event"), sendEvent: document.querySelector("#send-event"), eventJson: document.querySelector("#event-json"),
  wsUrl: document.querySelector("#sensor-ws-url"), wsConnect: document.querySelector("#connect-sensor"), wsStatus: document.querySelector("#sensor-status"),
  prescriptionJson: document.querySelector("#prescription-json"), loadPrescription: document.querySelector("#load-prescription"),
  motionAutoReplay: document.querySelector("#motion-auto-replay"), motionSpeed: document.querySelector("#motion-speed"),
  motionReplayCurrent: document.querySelector("#motion-replay-current"), motionReplayStatus: document.querySelector("#motion-replay-status"),
  motionReplayProgress: document.querySelector("#motion-replay-progress"), motionTelemetry: document.querySelector("#motion-telemetry"),
  motionAwareness: document.querySelector("#motion-awareness"), motionResultJson: document.querySelector("#motion-result-json"), motionPlayPause: document.querySelector("#motion-play-pause"),
  motionProgressLabel: document.querySelector("#motion-progress-label"),
  rawMotionSequence: document.querySelector("#motion-raw-sequence"),
  motionClipStart: document.querySelector("#motion-clip-start"), motionClipEnd: document.querySelector("#motion-clip-end"),
  motionRangeHint: document.querySelector("#motion-range-hint"),
  motionAnalysisFps: document.querySelector("#motion-analysis-fps"), motionReplayFault: document.querySelector("#motion-replay-fault"),
  motionReplayDelay: document.querySelector("#motion-replay-delay"), motionQueueAdd: document.querySelector("#motion-queue-add"),
  motionUseNow: document.querySelector("#motion-use-now"),
  motionQueueClear: document.querySelector("#motion-queue-clear"), motionReplayQueue: document.querySelector("#motion-replay-queue"),
};

let peerConnection;
let dataChannel;
let microphoneStream;
let cameraStream;
let sensorSocket;
let localSessionId;
let sessionReady = false;
let coachState = "not_started";
let latestCoachSnapshot;
let assistantTranscript = "";
let lastCoachUtterance = "";
let lastParticipantUtterance = "";
let pendingPrescription;
let conversationRecords = [];
const handledToolCalls = new Set();
const activeResponseIds = new Set();
const responsesWithSpokenOutput = new Set();
let pendingContinuation;
let inFlightContinuation;
let continuationSequence = 0;
let continuationRetryTimer;
let userSpeaking = false;
let realtimeFatalError;
let realtimeImageInputSupported = false;
let realtimeProtocol = "modern";
let editorMotionEventInFlight = false;
let restAdvanceTimer;
let scheduledRestKey;
let gvhmrReplay;
let pendingMotionReplay;
let motionReplayReleaseTimer;
const releasedMotionReplayKeys = new Set();
const automaticReadinessVisionKeys = new Set();
let presentationPaused = false;
let motionManuallyPaused = false;
let motionSupervisorPaused = false;
let rawMotionSequences = [];
let replayQueueItems = [];
let lastSuggestedRangeContext = "";

const samples = {
  correct: { exercise_id: "current_exercise", exercise_name: "Current exercise", rep_index: 1, phase: "rep_completed", valid_count_increment: 1, status: "correct", confidence: 0.95, summary: "One complete prescribed repetition was observed." },
  correction: { exercise_id: "current_exercise", exercise_name: "Current exercise", rep_index: 3, phase: "movement", status: "needs_correction", confidence: 0.92,
    issues: [{ code: "movement_quality", severity: "moderate", confidence: 0.92, summary: "The current movement did not meet its prescribed kinematic rule." }] },
  safety: { exercise_id: "current_exercise", exercise_name: "Current exercise", phase: "movement", status: "safety_concern", confidence: 0.94,
    issues: [{ code: "near_fall", severity: "high", confidence: 0.94, summary: "Rapid recovery steps and an emergency support grab were observed." }] },
  uncertain: { exercise_id: "current_exercise", exercise_name: "Current exercise", rep_index: 1, phase: "movement", status: "uncertain", confidence: 0.48,
    summary: "Required joints were occluded, so movement quality cannot be judged." },
  set_complete: { exercise_id: "current_exercise", exercise_name: "Current exercise", phase: "set_completed", valid_count_increment: 5, status: "correct", confidence: 0.96,
    summary: "The current prescribed target was observed." },
};

elements.start.addEventListener("click", startSession);
elements.stop.addEventListener("click", stopSession);
elements.newSession.addEventListener("click", startNewSession);
elements.pausePresentation.addEventListener("click", togglePresentationPause);
elements.motionPlayPause.addEventListener("click", toggleMotionPause);
elements.sample.addEventListener("change", loadSelectedSample);
elements.sendEvent.addEventListener("click", sendEditorEvent);
elements.wsConnect.addEventListener("click", toggleSensorSocket);
elements.loadPrescription.addEventListener("click", loadPrescriptionFromEditor);
elements.motionAutoReplay?.addEventListener("change", () => gvhmrReplay?.setAutoPlay(elements.motionAutoReplay.checked));
elements.motionSpeed?.addEventListener("change", () => gvhmrReplay?.setPlaybackSpeed(elements.motionSpeed.value));
elements.motionReplayCurrent?.addEventListener("click", () => {
  try { gvhmrReplay?.replayCurrent(); }
  catch (error) { renderMotionReplayStatus({ state: "error", message: error.message }); }
});
elements.reconnectCamera.addEventListener("click", reconnectCamera);
elements.rawMotionSequence?.addEventListener("change", updateRawSequenceRange);
elements.motionQueueAdd?.addEventListener("click", addRawSequenceToReplayQueue);
elements.motionUseNow?.addEventListener("click", replaceCurrentOrPendingReplay);
elements.motionQueueClear?.addEventListener("click", clearReplayQueue);
elements.motionReplayQueue?.addEventListener("click", handleReplayQueueAction);
elements.cameraDevice.addEventListener("change", () => {
  try { localStorage.setItem("otago-camera-device-id", elements.cameraDevice.value); } catch { /* storage is optional */ }
});
elements.voice.addEventListener("change", () => {
  try { localStorage.setItem("otago-openai-voice", elements.voice.value); } catch { /* storage is optional */ }
  elements.voiceHint.textContent = sessionReady
    ? `Selected ${elements.voice.value}; click New session to apply it.`
    : `Selected ${elements.voice.value}; it will apply when the next session starts.`;
});

loadSelectedSample();
await loadDemoPrescription();
await checkHealth();
await loadGvhmrReplay();
await loadRawGvhmrSequences();

async function loadGvhmrReplay() {
  gvhmrReplay = new GvhmrReplayEngine({
    dataUrl: "/motion-data/gvhmr-demo.json",
    playbackSpeed: Number(elements.motionSpeed?.value || 1),
    pushEvent: pushMotionEvent,
    onStatus: renderMotionReplayStatus,
    onTelemetry: (telemetry, active) => {
      elements.motionTelemetry.textContent = JSON.stringify(telemetry, null, 2);
      const percent = active.live ? 0 : Math.round(100 * active.frameIndex / active.segment.frames.length);
      if (!active.live) elements.motionReplayProgress.value = percent;
      const taskProgress = telemetry.detector === "knee_bends"
        ? ` · repetitions ${telemetry.detected_reps}/${setTargetFromSnapshot(latestCoachSnapshot?.current_set)}`
        : telemetry.detector === "one_leg_stand"
          ? ` · hold ${telemetry.continuous_hold_s}s`
          : "";
      elements.motionProgressLabel.textContent = active.live
        ? `${active.actionName}${taskProgress} · live frame ${active.frameIndex}`
        : `${active.actionName}${taskProgress} · frame ${active.frameIndex}/${active.segment.frames.length} · ${percent}%`;
    },
    onEvent: (event) => {
      elements.motionResultJson.textContent = JSON.stringify(event, null, 2);
      addLog("system", `GVHMR detector emitted ${event.exercise.id} / ${event.observation.phase}.`);
    },
  });
  try {
    const dataset = await gvhmrReplay.load();
    const actionNames = Object.keys(dataset.actions).join(" and ");
    renderMotionReplayStatus({ state: "ready", message: `Compact GVHMR streams loaded for ${actionNames}; waiting for active_set.` });
  } catch (error) {
    renderMotionReplayStatus({ state: "error", message: error.message });
  }
}

async function loadRawGvhmrSequences() {
  if (!elements.rawMotionSequence) return;
  try {
    const response = await fetch("/api/gvhmr/sequences");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not enumerate GVHMR outputs.");
    rawMotionSequences = Array.isArray(payload.sequences) ? payload.sequences : [];
    elements.rawMotionSequence.replaceChildren(...rawMotionSequences.map((sequence) => {
      const option = document.createElement("option");
      option.value = sequence.id;
      option.textContent = `${sequence.id} · ${sequence.duration_seconds}s · ${sequence.frame_count} frames`;
      return option;
    }));
    if (!rawMotionSequences.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No output1/output2 sequences found";
      elements.rawMotionSequence.append(option);
      elements.motionQueueAdd.disabled = true;
      if (elements.motionUseNow) elements.motionUseNow.disabled = true;
      return;
    }
    elements.motionQueueAdd.disabled = false;
    if (elements.motionUseNow) elements.motionUseNow.disabled = false;
    updateRawSequenceRange();
    addLog("system", `Found ${rawMotionSequences.length} raw GVHMR sequences under output1/output2.`);
  } catch (error) {
    elements.rawMotionSequence.replaceChildren();
    const option = document.createElement("option"); option.value = ""; option.textContent = "GVHMR outputs unavailable";
    elements.rawMotionSequence.append(option);
    elements.motionQueueAdd.disabled = true;
    if (elements.motionUseNow) elements.motionUseNow.disabled = true;
    addLog("error", `Could not load output1/output2 sequence list: ${error.message}`);
  }
}

function updateRawSequenceRange() {
  const sequence = rawMotionSequences.find((item) => item.id === elements.rawMotionSequence?.value);
  if (!sequence) return;
  elements.motionClipStart.max = String(Math.max(0, sequence.duration_seconds - 0.1));
  elements.motionClipEnd.max = String(sequence.duration_seconds);
  const suggested = suggestedIntervalForCurrentAction(sequence);
  elements.motionClipStart.value = String(suggested?.start_seconds ?? 0);
  elements.motionClipEnd.value = String(suggested?.end_seconds ?? Math.min(20, sequence.duration_seconds));
  if (elements.motionRangeHint) {
    elements.motionRangeHint.textContent = suggested
      ? `Suggested interval for ${suggested.action_name}: ${suggested.start_seconds.toFixed(1)}–${suggested.end_seconds.toFixed(1)} s. You may edit it for robustness tests.`
      : `No action-specific interval is known for this file. Current selection uses 0–${Math.min(20, sequence.duration_seconds).toFixed(1)} s; inspect or edit it before playback.`;
  }
  if (elements.motionReplayDelay) elements.motionReplayDelay.value = String(sequence.recommended_startup_delay_ms || 0);
}

function suggestedIntervalForCurrentAction(sequence) {
  const actionId = latestCoachSnapshot?.current_exercise?.id;
  const setId = latestCoachSnapshot?.current_set?.set_id;
  const action = actionId ? gvhmrReplay?.dataset?.actions?.[actionId] : null;
  if (!action || !String(action.source || "").startsWith(`${sequence.id}/`)) return null;
  const segment = action.segments?.find((item) => item.set_id === setId) || action.segments?.[0];
  const range = segment?.source_frame_range;
  const fps = Number(gvhmrReplay?.dataset?.source_fps || sequence.source_fps || 30);
  if (!Array.isArray(range) || range.length !== 2 || !fps) return null;
  return {
    action_name: latestCoachSnapshot.current_exercise?.name || action.name || actionId,
    start_seconds: Math.max(0, Number(range[0]) / fps),
    end_seconds: Math.min(sequence.duration_seconds, Number(range[1]) / fps),
  };
}

async function addRawSequenceToReplayQueue() {
  const item = await extractSelectedRawReplay("Add to replay queue");
  if (!item) return;
  replayQueueItems.push(item);
  applyReplayQueue();
  addLog("system", `Added raw GVHMR clip to replay position ${replayQueueItems.length}.`);
}

async function replaceCurrentOrPendingReplay() {
  const item = await extractSelectedRawReplay("Use now / replace pending");
  if (!item) return;
  try {
    const result = gvhmrReplay.replaceCurrentOrNext(item, latestCoachSnapshot, { deferStart: Boolean(pendingMotionReplay) });
    addLog("system", result.mode.startsWith("replaced_current")
      ? `Switched only the incoming replay frames to ${item.label}; the detector received no sequence-boundary reset.`
      : `Staged ${item.label} as the sensor input that will be present when the next active set begins.`);
    if (presentationPaused || motionManuallyPaused) gvhmrReplay.pause("Selected reconstruction is ready; replay remains paused.");
  } catch (error) {
    addLog("error", `Could not replace replay input: ${error.message}`);
  }
}

async function extractSelectedRawReplay(buttonLabel) {
  const sequence = rawMotionSequences.find((item) => item.id === elements.rawMotionSequence?.value);
  if (!sequence) return null;
  const startSeconds = Number(elements.motionClipStart.value);
  const endSeconds = Number(elements.motionClipEnd.value);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
    addLog("error", "Replay crop requires an end time after the start time.");
    return null;
  }
  elements.motionQueueAdd.disabled = true;
  if (elements.motionUseNow) elements.motionUseNow.disabled = true;
  const activeButton = buttonLabel.startsWith("Use") ? elements.motionUseNow : elements.motionQueueAdd;
  activeButton.textContent = "Extracting joints…";
  try {
    const response = await fetch("/api/gvhmr/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sequence_id: sequence.id,
        start_seconds: startSeconds,
        end_seconds: Math.min(endSeconds, sequence.duration_seconds),
        analysis_fps: Number(elements.motionAnalysisFps.value),
      }),
    });
    const dataset = await response.json();
    if (!response.ok) throw new Error(dataset.error || "Raw GVHMR extraction failed.");
    const registered = gvhmrReplay.registerDataset(dataset, `${sequence.id} ${startSeconds.toFixed(1)}–${Math.min(endSeconds, sequence.duration_seconds).toFixed(1)}s`);
    const clip = registered.clips[0];
    return {
      id: `queue-${Date.now()}-${replayQueueItems.length}`,
      clip_id: clip.id,
      label: `${sequence.id} · ${startSeconds.toFixed(1)}–${Math.min(endSeconds, sequence.duration_seconds).toFixed(1)}s · ${elements.motionAnalysisFps.value} FPS`,
      fault_preset: elements.motionReplayFault.value,
      startup_delay_ms: Number(elements.motionReplayDelay.value) || 0,
    };
  } catch (error) {
    addLog("error", `Could not extract raw GVHMR clip: ${error.message}`);
    return null;
  } finally {
    elements.motionQueueAdd.disabled = false;
    if (elements.motionUseNow) elements.motionUseNow.disabled = false;
    elements.motionQueueAdd.textContent = "Add to replay queue";
    if (elements.motionUseNow) elements.motionUseNow.textContent = "Use now / replace pending";
  }
}

function clearReplayQueue() {
  replayQueueItems = [];
  applyReplayQueue();
  addLog("system", "Replay queue cleared; prescription-matched built-in clips will be used.");
}

function handleReplayQueueAction(event) {
  const button = event.target.closest("button[data-queue-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  const action = button.dataset.queueAction;
  if (!Number.isInteger(index) || index < 0 || index >= replayQueueItems.length) return;
  if (action === "remove") replayQueueItems.splice(index, 1);
  if (action === "up" && index > 0) [replayQueueItems[index - 1], replayQueueItems[index]] = [replayQueueItems[index], replayQueueItems[index - 1]];
  if (action === "down" && index < replayQueueItems.length - 1) [replayQueueItems[index + 1], replayQueueItems[index]] = [replayQueueItems[index], replayQueueItems[index + 1]];
  applyReplayQueue();
}

function applyReplayQueue() {
  try {
    gvhmrReplay.setReplayQueue(replayQueueItems);
    renderReplayQueue();
  } catch (error) {
    addLog("error", `Replay queue rejected: ${error.message}`);
  }
}

function renderReplayQueue() {
  if (!elements.motionReplayQueue) return;
  elements.motionReplayQueue.replaceChildren();
  if (!replayQueueItems.length) {
    const item = document.createElement("li"); item.className = "placeholder";
    item.textContent = "Queue is empty; each active set will use its built-in matching clip.";
    elements.motionReplayQueue.append(item);
    return;
  }
  replayQueueItems.forEach((entry, index) => {
    const item = document.createElement("li"); item.className = "replay-queue-item";
    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${entry.label} · fault=${entry.fault_preset} · delay=${entry.startup_delay_ms}ms`;
    const actions = document.createElement("div"); actions.className = "replay-queue-actions";
    for (const [name, text] of [["up", "↑"], ["down", "↓"], ["remove", "Remove"]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "secondary";
      button.dataset.queueAction = name; button.dataset.index = String(index); button.textContent = text;
      if ((name === "up" && index === 0) || (name === "down" && index === replayQueueItems.length - 1)) button.disabled = true;
      actions.append(button);
    }
    item.append(label, actions); elements.motionReplayQueue.append(item);
  });
}

function renderMotionReplayStatus({ state = "idle", message = "Waiting for an active prescribed set." } = {}) {
  elements.motionReplayStatus.dataset.kind = state;
  elements.motionReplayStatus.textContent = message;
  if (state === "streaming") {
    elements.motionPlayPause.disabled = false;
    elements.motionPlayPause.textContent = "Pause motion";
  } else if (state === "paused") {
    elements.motionPlayPause.disabled = false;
    elements.motionPlayPause.textContent = "Resume motion";
  } else if (state === "ready" && latestCoachSnapshot?.current_state === "active_set") {
    elements.motionPlayPause.disabled = false;
    elements.motionPlayPause.textContent = "Play motion";
  } else if (["idle", "warning"].includes(state) && latestCoachSnapshot?.current_state === "active_set" && !gvhmrReplay?.active) {
    elements.motionPlayPause.disabled = false;
    elements.motionPlayPause.textContent = "Play motion";
  }
  if (["idle", "ready", "error", "warning"].includes(state) && !gvhmrReplay?.active) {
    elements.motionReplayProgress.value = 0;
    elements.motionProgressLabel.textContent = latestCoachSnapshot?.current_state === "active_set"
      ? "Motion input ready — press Play motion"
      : "Waiting for an active set";
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    realtimeImageInputSupported = Boolean(health.realtime_image_input_supported);
    realtimeProtocol = health.realtime_protocol || "modern";
    configureVoiceSelector(health.supported_voices, health.default_voice || health.voice || "marin");
    if (!health.api_key_configured) setStatus("Add XTY_API_KEY to .env before starting.", "warning");
    addLog("system", `${health.provider} · ${health.model} · ${health.transport} · ${realtimeProtocol} protocol`);
    if (!realtimeImageInputSupported) addLog("system", "XTY Realtime image transport disabled: this provider route closes on input_image; camera captures will fall back without ending voice.");
  } catch { setStatus("Local server is unavailable.", "error"); }
}

async function loadDemoPrescription() {
  try {
    const response = await fetch("/api/demo-prescription");
    pendingPrescription = await response.json();
    elements.prescriptionJson.value = JSON.stringify(pendingPrescription, null, 2);
  } catch (error) { addLog("error", `Could not load sample prescription: ${error.message}`); }
}

async function startSession() {
  elements.start.disabled = true;
  setStatus("Requesting microphone and camera access…", "working");
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try {
      await connectCamera();
    } catch (cameraError) {
      cameraStream = undefined;
      setCameraStatus("Unavailable — voice fallback active", "warning");
      addLog("error", `Camera unavailable; vision checks will fall back to voice: ${cameraError.message}`);
    }
    setStatus("Connecting through the local XTY Realtime relay…", "working");
    const relay = new XtyRealtimeAudioTransport({
      microphoneStream,
      voice: elements.voice.value,
      onEvent: handleRealtimeMessage,
      onError: (error) => { if (dataChannel === relay) failSession(error.message); },
      onClose: () => { if (dataChannel === relay && sessionReady) failSession("XTY Realtime relay closed."); },
    });
    dataChannel = relay;
    await relay.connect();
    localSessionId = relay.localSessionId;
    addLog("system", `XTY relay message limit: ${formatBytes(dataChannelMaxMessageSize())}.`);
    sessionReady = true;
    elements.stop.disabled = false;
    elements.newSession.disabled = false;
    elements.pausePresentation.disabled = false;

    if (pendingPrescription) await submitPrescription(pendingPrescription, false);
    else await refreshState();
    setStatus(`Connected to XTY ${relay.model} with ${relay.voice} — you can speak now.`, "connected");
    elements.voiceHint.textContent = `${relay.voice} is active for this session. Choose another voice and click New session to switch.`;
    addLog("system", `XTY Realtime WebSocket relay connected (${relay.model}, voice ${relay.voice}).`);
    const week = latestCoachSnapshot?.program_week || "current";
    const fastDemo = Boolean(latestCoachSnapshot?.fast_demo_skip_opening_checks);
    const greetingInstruction = fastDemo
      ? "Greet naturally in one short sentence, for example: ‘Hi, I’m your Otago coach—let’s get started.’ Speak only as a live coach addressing the participant. After speaking the greeting, silently submit greeting_ready in this same response."
      : `Say hello, welcome the participant ${Number(week) > 1 ? `back to week ${week}` : "to week 1"} of Otago training, briefly say you will follow the PT-prescribed plan and keep guidance concise, then ask whether they are ready for a quick safety check. This is the opening greeting only; do not advance the controller.`;
    sendConversationText(`[SESSION_START] ${greetingInstruction}${fastDemo ? "" : " This system event is not participant readiness consent."}`, false);
    requestResponse({ instructions: greetingInstruction, tool_choice: fastDemo ? "auto" : "none", max_output_tokens: 700 });
  } catch (error) {
    console.error(error);
    failSession(error.message || "Could not start the session.");
  }
}

async function stopSession() {
  await persistSessionLog("user_ended_session");
  cleanupSession();
  setStatus("Not connected.", "idle");
  addLog("system", "Voice connection ended locally.");
}

async function startNewSession() {
  elements.newSession.disabled = true;
  await persistSessionLog("new_session_button");
  cleanupSession();
  setStatus("Starting a fresh session…", "working");
  await startSession();
}

function failSession(message) {
  void persistSessionLog("connection_or_realtime_error");
  cleanupSession();
  setStatus(message, "error");
  addLog("error", message);
}

function cleanupSession() {
  sessionReady = false; realtimeFatalError = undefined; coachState = "not_started"; assistantTranscript = ""; lastCoachUtterance = ""; lastParticipantUtterance = ""; localSessionId = undefined;
  conversationRecords = [];
  handledToolCalls.clear();
  activeResponseIds.clear();
  responsesWithSpokenOutput.clear();
  pendingContinuation = undefined; inFlightContinuation = undefined; userSpeaking = false;
  clearTimeout(continuationRetryTimer); continuationRetryTimer = undefined;
  clearTimeout(restAdvanceTimer); restAdvanceTimer = undefined; scheduledRestKey = undefined;
  clearTimeout(motionReplayReleaseTimer); motionReplayReleaseTimer = undefined; pendingMotionReplay = undefined;
  releasedMotionReplayKeys.clear();
  automaticReadinessVisionKeys.clear();
  presentationPaused = false; motionManuallyPaused = false; motionSupervisorPaused = false;
  try { dataChannel?.close(); } catch { /* already closed */ }
  try { peerConnection?.close(); } catch { /* already closed */ }
  microphoneStream?.getTracks().forEach((track) => track.stop());
  cameraStream?.getTracks().forEach((track) => track.stop());
  dataChannel = undefined; peerConnection = undefined; microphoneStream = undefined; cameraStream = undefined;
  elements.cameraPreview.srcObject = null;
  setCameraStatus("Off", "idle");
  elements.cameraDiagnostics.textContent = "No active camera track.";
  elements.audio.srcObject = null; elements.audio.muted = false; elements.start.disabled = false; elements.stop.disabled = true; elements.newSession.disabled = true;
  elements.pausePresentation.disabled = true; elements.pausePresentation.textContent = "Pause presentation";
  elements.motionPlayPause.disabled = true; elements.motionPlayPause.textContent = "Pause motion";
  elements.coachState.textContent = "Not started";
  elements.stateBanner.textContent = "Not started";
  elements.stateBanner.dataset.state = "not_started";
  elements.stateDetail.textContent = "Start a voice session to create a fresh Otago run.";
  elements.coachingStyle.textContent = "Determined by program week";
  elements.voiceHint.textContent = `Selected ${elements.voice.value}; it will apply when the next session starts.`;
  gvhmrReplay?.reset();
}

function configureVoiceSelector(voices, fallback) {
  const supported = Array.isArray(voices) && voices.length ? voices : [fallback];
  let saved;
  try { saved = localStorage.getItem("otago-openai-voice"); } catch { /* storage is optional */ }
  const selected = supported.includes(saved) ? saved : fallback;
  elements.voice.replaceChildren(...supported.map((voice) => {
    const option = document.createElement("option");
    option.value = voice;
    option.textContent = voice === "marin" ? "Marin — recommended" : voice === "cedar" ? "Cedar — recommended" : voice[0].toUpperCase() + voice.slice(1);
    return option;
  }));
  elements.voice.value = selected;
  elements.voiceHint.textContent = `Selected ${selected}; it will apply when the next session starts.`;
}

function handleRealtimeMessage(messageEvent) {
  let event;
  try { event = JSON.parse(messageEvent.data); } catch { return; }

  if (["response.created", "response.done", "session.updated", "error"].includes(event.type)) {
    reportClientEvent("realtime_event", {
      type: event.type,
      response_id: event.response?.id,
      response_status: event.response?.status,
      status_details: event.response?.status_details,
      error: event.error?.message,
      state: coachState,
    });
  }

  if (event.type === "input_audio_buffer.speech_started") userSpeaking = true;
  if (event.type === "input_audio_buffer.speech_stopped") {
    userSpeaking = false;
    scheduleContinuationFlush(250);
  }
  if (event.type === "response.created" && event.response?.id) {
    activeResponseIds.add(event.response.id);
    if (inFlightContinuation && !inFlightContinuation.responseId) {
      inFlightContinuation.responseId = event.response.id;
      clearTimeout(inFlightContinuation.startTimer);
      inFlightContinuation.startTimer = undefined;
      reportClientEvent("state_advance_requested", { phase: "response_started", response_id: event.response.id, token: inFlightContinuation.token, state: coachState });
    }
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") addTranscript("You", event.transcript || "");
  if (["response.output_audio_transcript.delta", "response.audio_transcript.delta"].includes(event.type)) {
    assistantTranscript += event.delta || "";
    if (event.response_id && event.delta) responsesWithSpokenOutput.add(event.response_id);
  }
  if (["response.output_audio_transcript.done", "response.audio_transcript.done"].includes(event.type)) {
    if (event.response_id && (event.transcript || assistantTranscript)) responsesWithSpokenOutput.add(event.response_id);
    addTranscript("Coach", event.transcript || assistantTranscript); assistantTranscript = "";
  }
  if (event.type === "response.output_text.delta") {
    assistantTranscript += event.delta || "";
    if (event.response_id && event.delta) responsesWithSpokenOutput.add(event.response_id);
  }
  if (event.type === "response.output_text.done") {
    if (event.response_id && (event.text || assistantTranscript)) responsesWithSpokenOutput.add(event.response_id);
    addTranscript("Coach", event.text || assistantTranscript); assistantTranscript = "";
  }
  if (event.type === "error" && !handlePermanentRealtimeError(event.error)) {
    failSession(event.error?.message || "Realtime API error.");
  }

  if (event.type === "response.done" && event.response?.id) handleResponseDone(event.response);

  const call = completedFunctionCall(event);
  if (call && !handledToolCalls.has(call.call_id)) {
    handledToolCalls.add(call.call_id);
    reportClientEvent("function_call_received", { name: call.name, call_id: call.call_id, state: coachState });
    void handleFunctionCall(call);
  }
}

function completedFunctionCall(event) {
  if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
    return { call_id: event.item.call_id, name: event.item.name, arguments: event.item.arguments || "{}", response_id: event.response_id };
  }
  if (event.type === "response.function_call_arguments.done" && event.call_id && event.name) {
    return { call_id: event.call_id, name: event.name, arguments: event.arguments || "{}", response_id: event.response_id };
  }
  return null;
}

async function handleFunctionCall(call) {
  try {
    let args = {};
    try { args = JSON.parse(call.arguments || "{}"); } catch { /* server validation will decide */ }
    const response = await fetch(`/api/sessions/${localSessionId}/tool-call`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: call.name, arguments: args }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Local function execution failed.");
    if (payload.result?.capture_vision) {
      await fulfillVisionFunctionCall(call, payload);
      return;
    }
    sendEvent({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(payload.result) } });
    if (payload.session_update) sendEvent(payload.session_update);
    updateCoachState(payload.snapshot);
    if (payload.result?.pause_motion) {
      motionSupervisorPaused = true;
      gvhmrReplay?.pause("Motion supervision paused pending participant clarification.");
      elements.motionPlayPause.disabled = true;
      elements.motionPlayPause.textContent = "Paused for safety check";
    }
    const transition = payload.result?.state_changed ? `${payload.result.previous_state} → ${payload.result.current_state}` : `stayed in ${payload.result?.current_state}`;
    addLog(payload.result?.ok ? "system" : "error", `Function ${call.name}: ${transition}${payload.result?.error ? ` — ${payload.result.error}` : ""}`);
    if (call.name === "get_current_progress" && payload.result?.progress_query) {
      const progress = payload.result.progress_query;
      queueContinuation({
        instructions: `Answer the participant's progress question from this authoritative controller result: ${JSON.stringify(progress)}. Be brief and natural. For repetitions, say how many are complete and how many remain. For a timed hold, say elapsed and remaining seconds. If counting_enabled is false, mention naturally that progress is paused. Do not mention functions, tools, JSON, or the controller.`,
        tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 300,
      }, { state: payload.snapshot?.current_state, action: payload.snapshot?.current_exercise?.name, reason: "progress_query" });
    } else if (payload.result?.resume_motion) {
      motionSupervisorPaused = false;
      queueContinuation({
        instructions: "Acknowledge briefly that they are okay, tell them to resume only when steady and ready, and repeat the current target in one short sentence. Do not restart the set count.",
        tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 350,
      }, { state: payload.snapshot?.current_state, action: payload.snapshot?.current_exercise?.name, reason: "perception_resume" });
    } else if (call.name === "submit_visual_observation" && payload.result?.attention?.mode === "safety_check") {
      motionSupervisorPaused = true;
      gvhmrReplay?.pause("Visual safety hypothesis; waiting for participant confirmation.");
      elements.motionPlayPause.disabled = true;
      elements.motionPlayPause.textContent = "Paused for safety check";
      queueContinuation({
        instructions: `${payload.result.attention.question} Use one direct, calm sentence. Do not claim the image proves a fall or proves safety.`,
        tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 400,
      }, { state: coachState, action: payload.snapshot?.current_exercise?.name, reason: "visual_safety_check" });
    } else if (call.name === "submit_visual_observation" && payload.result?.attention?.mode === "coach_cue") {
      queueContinuation({
        instructions: `Say only this meaning naturally and briefly: ${payload.result.attention.cue} Do not mention vision, detection, classification, or internal state.`,
        tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 300,
      }, { state: coachState, action: payload.snapshot?.current_exercise?.name, reason: "visual_activity_cue" });
    } else if (call.name === "submit_visual_observation" && payload.result?.attention?.mode === "voice_check") {
      queueContinuation({
        instructions: `${payload.result.attention.question} Ask only one short question and do not mention vision or system uncertainty.`,
        tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 300,
      }, { state: coachState, action: payload.snapshot?.current_exercise?.name, reason: "visual_activity_question" });
    } else if (payload.result?.auto_route) {
      addLog("system", `Controller auto-route: rest → ${payload.result.auto_route}.`);
      const routed = await autoRouteFromRest();
      if (routed.result?.continue_response) queueStateAdvance(routed.snapshot, routed.session_update, "rest_auto_route");
    } else if (call.name === "submit_session_event" && args.event === "motion_observation" && payload.result?.motion_progress?.target_reached) {
      queueContinuation({
        instructions: `The authoritative controller count is ${payload.result.motion_progress.observed_count}/${payload.result.motion_progress.target_count}. Submit exactly one controller event now: submit_session_event with event="set_completed" and count=${payload.result.motion_progress.target_count}. Output only the function call; do not wait for another motion event or participant utterance.`,
        tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 700,
      }, { state: payload.snapshot?.current_state, action: payload.snapshot?.current_exercise?.name, reason: "motion_target_reached" });
    } else if (call.name === "submit_session_event" && args.event === "motion_observation" && payload.result?.speak) {
      queueContinuation({
        instructions: "Continue the current set with one brief, specific recovery cue grounded in the latest motion result. Mention the current count only if useful, then wait for the next motion event.",
        tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 700,
      }, { state: payload.snapshot?.current_state, action: payload.snapshot?.current_exercise?.name, reason: "motion_feedback" });
    } else if (payload.result?.continue_response) {
      if (await maybeFulfillAutomaticReadinessVision(payload)) return;
      queueStateAdvance(payload.snapshot, payload.session_update, payload.result?.reason || call.name);
    }
  } catch (error) { failSession(`Function-call loop failed: ${error.message}`); }
}

async function maybeFulfillAutomaticReadinessVision(payload) {
  const snapshot = payload.snapshot;
  if (!["readiness_check", "set_readiness"].includes(snapshot?.current_state)) return false;
  const key = snapshot.current_state === "readiness_check"
    ? `${snapshot.run_number}:readiness_check`
    : `${snapshot.run_number}:${snapshot.current_exercise?.id}:${snapshot.current_set?.set_id}:set_readiness`;
  if (automaticReadinessVisionKeys.has(key)) return false;
  automaticReadinessVisionKeys.add(key);

  const purpose = snapshot.current_state === "readiness_check" ? "environment_readiness" : "exercise_setup";
  const focus = snapshot.current_state === "readiness_check"
    ? "chair, prescribed equipment, floor space, lighting, and full-body camera framing"
    : `starting posture, prescribed support and equipment, clear space, and full-body framing for ${snapshot.current_exercise?.name || "the exercise"}`;
  const response = await fetch(`/api/sessions/${localSessionId}/tool-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "capture_vision_snapshot",
      arguments: { purpose, focus, reason: "Controller-mandated readiness evidence before the coach asks any readiness question." },
    }),
  });
  const visionPayload = await response.json();
  if (!response.ok || !visionPayload.result?.capture_vision) {
    automaticReadinessVisionKeys.delete(key);
    throw new Error(visionPayload.result?.error || visionPayload.error || "Automatic readiness vision request failed.");
  }
  await fulfillVisionFunctionCall(null, visionPayload, { source: "controller_auto" });
  return true;
}

async function fulfillVisionFunctionCall(call, payload, { source = "realtime_function" } = {}) {
  const request = payload.result?.vision_request || {};
  const kind = request.purpose || "agent_requested";
  updateCoachState(payload.snapshot);
  addLog("system", call
    ? `Function ${call.name}: autonomous capture requested for ${kind}.`
    : `Controller captured ${kind} before the readiness response.`);

  const capture = await captureAndStorePhoto(kind, {
    source,
    focus: request.focus || "current visible coaching context",
    reason: request.reason || "",
    state: payload.snapshot?.current_state,
    exercise_id: payload.snapshot?.current_exercise?.id,
    set_id: payload.snapshot?.current_set?.set_id,
  });
  const toolOutput = capture
    ? { ok: true, status: "captured", kind, filename: capture.filename, width: capture.width, height: capture.height }
    : { ok: false, status: "camera_unavailable", kind, instruction: "Continue with the minimum necessary voice question; do not retry immediately." };
  if (call) sendEvent({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(toolOutput) } });
  if (payload.session_update) sendEvent(payload.session_update);

  let imageDelivered = false;
  if (capture) {
    try {
      sendVisionInput({
        capture,
        text: `[VISION_SNAPSHOT ${kind}]\nFocus: ${request.focus || "current visible coaching context"}\nReason: ${request.reason || "not specified"}\nUse this still only for visible evidence. The original image is retained locally for this approved demo.`,
        request: false,
      });
      imageDelivered = true;
    } catch (error) {
      addLog("error", `Vision transport skipped without ending the session: ${error.message}`);
    }
  }
  const readinessVisionGuidance = ["readiness_check", "set_readiness"].includes(payload.snapshot?.current_state)
    ? " If the participant verbally confirms readiness but the image shows a noncritical visible mismatch, state one practical reminder and continue using the appropriate ready event with the issue and vision evidence. Only a clear immediate hazard should block exercise and use the safety function."
    : "";
  const motionObservationInstruction = request.purpose === "motion_uncertainty" && imageDelivered
    ? `Use the attached still only as supporting visible evidence. Output exactly one submit_visual_observation function call. Choose the closest activity label, provide calibrated confidence, visibility booleans, whether the expected exercise is visible, whether a possible safety concern is visible, and up to four concrete visible facts. Do not speak before the function call and do not infer symptoms or medical safety.`
    : `Continue now in ${payload.snapshot?.current_state || coachState}. ${imageDelivered ? `Use the attached still to resolve every clearly visible fact relevant to ${request.focus || "the visible setup"}. Do not ask the participant to confirm facts that are clearly visible; ask at most one question only for nonvisual, occluded, or uncertain requirements.` : "No usable still is available; ask at most one necessary user-report question."}${readinessVisionGuidance} Do not mention photography, saving, checking, bookkeeping, or internal state. Give the next useful coaching cue immediately, or silently submit the appropriate controller event.`;
  queueContinuation({
    instructions: motionObservationInstruction,
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_output_tokens: 700,
  }, { state: payload.snapshot?.current_state, action: payload.snapshot?.current_exercise?.name || payload.snapshot?.current_warm_up?.name, reason: "vision_result" });
}

async function autoRouteFromRest() {
  const response = await fetch(`/api/sessions/${localSessionId}/auto-route`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const payload = await response.json();
  if (!response.ok || !payload.result?.ok) throw new Error(payload.result?.error || payload.error || "Automatic rest routing failed.");
  if (payload.session_update) sendEvent(payload.session_update);
  updateCoachState(payload.snapshot);
  addLog("system", `Function route_from_rest (controller): ${payload.result.previous_state} → ${payload.result.current_state}.`);
  return payload;
}

async function refreshState() {
  const response = await fetch(`/api/sessions/${localSessionId}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not read local state.");
  updateCoachState(payload.snapshot);
  if (payload.session_update) sendEvent(payload.session_update);
}

function sendConversationText(text, request = false) {
  assertSession();
  sendEvent({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  if (request) requestResponse();
}

function sendVisionInput({ capture, text, request = true }) {
  assertSession();
  if (!realtimeImageInputSupported) throw new Error("XTY Realtime image input is unavailable on the configured provider route.");
  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text },
        { type: "input_image", image_url: capture.transportDataUrl || capture.dataUrl, detail: "high" },
      ],
    },
  });
  addLog("system", `Vision image sent: ${capture.kind} · ${capture.filename} · transport ${formatBytes(capture.transportBytes || dataUrlByteLength(capture.dataUrl))}.`);
  if (request) requestResponse();
}

async function reconnectCamera() {
  elements.reconnectCamera.disabled = true;
  setCameraStatus("Connecting…", "working");
  try {
    await connectCamera();
    addLog("system", "Camera reconnected and passed the frame-quality check.");
  } catch (error) {
    setCameraStatus("Unavailable — voice fallback active", "warning");
    elements.cameraDiagnostics.textContent = error.message;
    addLog("error", `Camera reconnect failed: ${error.message}`);
  } finally {
    elements.reconnectCamera.disabled = false;
  }
}

async function connectCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera capture is unavailable in this browser context.");
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
  elements.cameraPreview.srcObject = null;

  let savedDeviceId = "";
  try { savedDeviceId = localStorage.getItem("otago-camera-device-id") || ""; } catch { /* storage is optional */ }
  const requestedDeviceId = elements.cameraDevice.value || savedDeviceId;
  let stream;
  try {
    stream = await requestCameraStream(requestedDeviceId);
  } catch (error) {
    if (!requestedDeviceId) throw error;
    addLog("error", `Saved camera is unavailable; falling back to automatic selection: ${error.message}`);
    elements.cameraDevice.value = "";
    try { localStorage.removeItem("otago-camera-device-id"); } catch { /* storage is optional */ }
    stream = await requestCameraStream();
  }
  await attachCameraStream(stream);
  const devices = await populateCameraDevices(requestedDeviceId);

  if (!requestedDeviceId) {
    const preferred = choosePreferredCamera(devices);
    const currentId = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (preferred?.deviceId && preferred.deviceId !== currentId) {
      stream.getTracks().forEach((track) => track.stop());
      stream = await requestCameraStream(preferred.deviceId);
      await attachCameraStream(stream);
      elements.cameraDevice.value = preferred.deviceId;
      try { localStorage.setItem("otago-camera-device-id", preferred.deviceId); } catch { /* storage is optional */ }
    }
  }

  cameraStream = stream;
  const track = stream.getVideoTracks()[0];
  monitorCameraTrack(track);
  const label = track.label || "Unnamed camera";
  const settings = track.getSettings();
  let quality;
  try {
    quality = await waitForUsableCameraFrame({ timeoutMs: 8_000, consecutiveFrames: 2 });
  } catch (error) {
    stream.getTracks().forEach((item) => item.stop());
    cameraStream = undefined;
    elements.cameraPreview.srcObject = null;
    throw new Error(`${label}: ${error.message}`);
  }
  showCameraDiagnostics(label, settings, quality);
  setCameraStatus(`Ready — ${label}`, "connected");
  addLog("system", `Camera ready: ${label} · ${settings.width || "?"}×${settings.height || "?"} · ${quality.summary}.`);
  return stream;
}

function requestCameraStream(deviceId = "") {
  return navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
      width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30, min: 10 },
    },
  });
}

async function attachCameraStream(stream) {
  cameraStream = stream;
  elements.cameraPreview.srcObject = stream;
  await elements.cameraPreview.play();
  await waitForCameraFrame();
}

async function populateCameraDevices(selectedId = "") {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  elements.cameraDevice.replaceChildren(new Option("Automatic — prefer built-in camera", ""));
  for (const [index, device] of devices.entries()) {
    elements.cameraDevice.append(new Option(device.label || `Camera ${index + 1}`, device.deviceId));
  }
  if (selectedId && devices.some((device) => device.deviceId === selectedId)) elements.cameraDevice.value = selectedId;
  return devices;
}

function choosePreferredCamera(devices) {
  const score = (device) => {
    const label = device.label.toLowerCase();
    let value = 0;
    if (/facetime|built[- ]?in|integrated|macbook/.test(label)) value += 100;
    if (/continuity|iphone|desk view|obs|virtual|screen|capture|manycam|snap camera/.test(label)) value -= 150;
    return value;
  };
  return [...devices].sort((left, right) => score(right) - score(left))[0];
}

function monitorCameraTrack(track) {
  track.addEventListener("mute", () => {
    setCameraStatus("Camera muted — vision paused", "warning");
    elements.cameraDiagnostics.textContent = `${track.label || "Camera"} stopped delivering frames.`;
  });
  track.addEventListener("unmute", () => setCameraStatus(`Ready — ${track.label || "camera"}`, "connected"));
  track.addEventListener("ended", () => {
    setCameraStatus("Camera disconnected — voice fallback active", "warning");
    elements.cameraDiagnostics.textContent = `${track.label || "Camera"} track ended.`;
  });
}

function inspectVideoFrame(video) {
  const sample = document.createElement("canvas");
  sample.width = 80; sample.height = 60;
  const context = sample.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(video, 0, 0, sample.width, sample.height);
  return assessPixelData(context.getImageData(0, 0, sample.width, sample.height).data);
}

function inspectCanvasFrame(canvas) {
  const sample = document.createElement("canvas");
  sample.width = 80; sample.height = 60;
  const context = sample.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  return assessPixelData(context.getImageData(0, 0, sample.width, sample.height).data);
}

function showCameraDiagnostics(label, settings, quality) {
  elements.cameraDiagnostics.textContent = `${label} · ${settings.width || "?"}×${settings.height || "?"} @ ${settings.frameRate ? Math.round(settings.frameRate) : "?"} fps · ${quality.summary}`;
}

function publicCameraSettings(settings) {
  return {
    width: settings.width || null,
    height: settings.height || null,
    frame_rate: settings.frameRate || null,
    facing_mode: settings.facingMode || null,
  };
}

async function captureAndStorePhoto(kind, context = {}) {
  const track = cameraStream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live" || !track.enabled || track.muted) {
    addLog("error", `Vision check skipped (${kind}): camera is unavailable.`);
    return null;
  }
  try {
    await waitForCameraFrame();
    await waitForFreshCameraFrame();
    let previewQuality = inspectVideoFrame(elements.cameraPreview);
    if (!previewQuality.usable) {
      previewQuality = await waitForUsableCameraFrame({ timeoutMs: 5_000, consecutiveFrames: 1 });
    }
    const sourceWidth = elements.cameraPreview.videoWidth || 1280;
    const sourceHeight = elements.cameraPreview.videoHeight || 960;
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context2d = canvas.getContext("2d", { alpha: false });
    if (!context2d) throw new Error("Canvas is unavailable.");
    context2d.drawImage(elements.cameraPreview, 0, 0, width, height);
    const quality = inspectCanvasFrame(canvas);
    showCameraDiagnostics(track.label || "Unnamed camera", track.getSettings(), quality);
    if (!quality.usable) throw new Error(`Rejected an unusable camera frame (${quality.summary}). Select the built-in camera, uncover the lens, or improve lighting.`);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    const transport = createTransportImage(canvas);
    setCameraStatus(`Captured ${kind}`, "working");
    const response = await fetch(`/api/sessions/${localSessionId}/vision-capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, state: coachState, width, height, image_data: dataUrl, context: { ...context, camera_label: track.label, camera_settings: publicCameraSettings(track.getSettings()), frame_quality: quality } }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not save the vision image.");
    elements.lastCapture.src = dataUrl;
    elements.lastCaptureCaption.textContent = `${kind} · original ${width}×${height} · sent ${transport.width}×${transport.height} (${formatBytes(transport.bytes)})`;
    setCameraStatus("Ready — last photo saved locally", "connected");
    reportClientEvent("vision_capture", { kind, filename: payload.filename, state: coachState, context });
    return {
      kind, dataUrl, transportDataUrl: transport.dataUrl, transportBytes: transport.bytes,
      transportWidth: transport.width, transportHeight: transport.height,
      filename: payload.filename, relativePath: payload.relative_path, width, height,
    };
  } catch (error) {
    setCameraStatus("Capture failed — voice fallback active", "warning");
    addLog("error", `Vision capture failed (${kind}): ${error.message}`);
    return null;
  }
}

async function waitForCameraFrame() {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const track = cameraStream?.getVideoTracks()[0];
    if (track?.readyState === "live" && track.enabled && !track.muted && elements.cameraPreview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && elements.cameraPreview.videoWidth) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for an unmuted camera frame.");
}

async function waitForUsableCameraFrame({ timeoutMs = 8_000, consecutiveFrames = 2 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let usableInARow = 0;
  let bestQuality = null;
  while (Date.now() < deadline) {
    const remaining = Math.max(250, deadline - Date.now());
    try {
      await waitForFreshCameraFrame(Math.min(2_000, remaining));
    } catch {
      continue;
    }
    const quality = inspectVideoFrame(elements.cameraPreview);
    if (!bestQuality || quality.mean > bestQuality.mean || (quality.mean === bestQuality.mean && quality.deviation > bestQuality.deviation)) bestQuality = quality;
    usableInARow = quality.usable ? usableInARow + 1 : 0;
    if (usableInARow >= consecutiveFrames) return quality;
  }
  const summary = bestQuality?.summary || "no readable frame";
  throw new Error(`Camera did not stabilize before the quality timeout (best frame: ${summary}). Check the selected camera and whether another app is holding it.`);
}

function waitForFreshCameraFrame(timeoutMs = 2_000) {
  if (typeof elements.cameraPreview.requestVideoFrameCallback === "function") {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Camera did not deliver a fresh frame.")), timeoutMs);
      elements.cameraPreview.requestVideoFrameCallback(() => { clearTimeout(timeout); resolve(); });
    });
  }
  return new Promise((resolve) => setTimeout(resolve, Math.min(120, timeoutMs)));
}

function createTransportImage(sourceCanvas) {
  const messageLimit = dataChannelMaxMessageSize();
  const targetBytes = Math.max(8_000, Math.min(Math.floor(messageLimit * 0.68), messageLimit - 16_000));
  const widths = [768, 640, 512, 384, 320, 256].map((value) => Math.min(value, sourceCanvas.width)).filter((value, index, values) => value > 0 && values.indexOf(value) === index);
  const qualities = [0.72, 0.62, 0.52, 0.42, 0.35];
  let smallest;
  for (const width of widths) {
    const height = Math.max(1, Math.round(sourceCanvas.height * width / sourceCanvas.width));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(sourceCanvas, 0, 0, width, height);
    for (const quality of qualities) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const bytes = dataUrlByteLength(dataUrl);
      smallest = { dataUrl, bytes, width, height, quality };
      if (bytes <= targetBytes) return smallest;
    }
  }
  if (smallest && smallest.bytes < messageLimit - 8_000) return smallest;
  throw new Error(`Could not compress the vision image below the RTCDataChannel limit (${formatBytes(messageLimit)}).`);
}

function dataChannelMaxMessageSize() {
  const relayLimit = Number(dataChannel?.maxMessageSize);
  if (Number.isFinite(relayLimit) && relayLimit > 0) return relayLimit;
  const negotiated = Number(peerConnection?.sctp?.maxMessageSize);
  return Number.isFinite(negotiated) && negotiated > 0 ? negotiated : 262_144;
}

function dataUrlByteLength(value) {
  return new TextEncoder().encode(value || "").byteLength;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`;
}

function queueStateAdvance(snapshot, sessionUpdate, reason = "state_transition") {
  const state = snapshot?.current_state || coachState;
  const action = actionForSnapshot(snapshot) || "the current session step";
  queueContinuation({
    instructions: `Continue now in ${state} for ${action}. ${transitionGuidance(reason, state)} Deliver only the information still missing for the current task card. Do not automatically repeat the exercise name, target, acknowledgement, or transition. Keep the whole turn to one or two short sentences.`,
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_output_tokens: 700,
  }, { state, action, reason, continuityAware: true });
}

function transitionGuidance(reason, state) {
  if (reason === "fast_demo_opening_complete") return "Continue the greeting into the first prescribed exercise. Add only the target, support, or cue not already spoken.";
  if (reason === "greeting_ready") return "Begin the first safety question directly; do not acknowledge readiness a second time.";
  if (reason === "readiness_passed") return "Move into today's plan without recapping or re-confirming readiness.";
  if (reason === "plan_understood") return "Begin the first warm-up cue without confirming their confirmation.";
  if (reason === "motion_demo_warm_up_omitted") return "Bridge directly into the first prescribed exercise and speak only about what the participant should do now.";
  if (["next_warm_up", "warm_up_motion_target_reached"].includes(reason)) return "Use at most a short connective phrase, then give only the next movement's missing cue.";
  if (["warm_up_complete", "warm_up_motion_complete"].includes(reason)) return "Mark the category change naturally: ‘Warm-up complete. Let’s move into the first exercise.’";
  if (reason === "prepare_exercise") return "Ask only for the missing static setup information; do not reintroduce the exercise.";
  if (["setup_ready", "setup_ready_with_reminder"].includes(reason)) return "Give the direct start cue without narrating a check.";
  if (reason === "side_switch") return "Move straight to the prescribed other side. Say it conversationally, give the target and one cue, and do not mention rest, another readiness check, or another photo.";
  if (reason === "exercise_complete") return "Acknowledge the completed exercise briefly and offer the prescribed 15-second breather before the next exercise.";
  if (["next_exercise", "timed_rest_complete"].includes(reason)) return "Link naturally out of the short break and introduce the next exercise.";
  return `Use one brief context-specific bridge into ${state}.`;
}

function actionForSnapshot(snapshot) {
  const state = snapshot?.current_state;
  if (state === "warm_up_sequence") return snapshot?.current_warm_up?.name || null;
  if (["exercise_intro", "set_readiness", "active_set", "rest"].includes(state)) return snapshot?.current_exercise?.name || null;
  return null;
}

function queueContinuation(overrides, meta = {}, delayMs = 0) {
  const token = ++continuationSequence;
  pendingContinuation = { token, overrides, meta, attempts: 0, rateLimitWaits: 0, queuedAt: Date.now() };
  reportClientEvent("state_advance_requested", { phase: "queued", token, ...meta });
  if (delayMs > 0) scheduleContinuationFlush(delayMs); else flushContinuation();
}

function scheduleContinuationFlush(delayMs = 0) {
  clearTimeout(continuationRetryTimer);
  continuationRetryTimer = setTimeout(flushContinuation, delayMs);
}

function flushContinuation() {
  if (!pendingContinuation || inFlightContinuation || activeResponseIds.size || userSpeaking || !sessionReady || presentationPaused) return;
  if (pendingContinuation.attempts >= 4) {
    addLog("error", `Automatic voice continuation failed after ${pendingContinuation.attempts} attempts in ${pendingContinuation.meta.state || coachState}.`);
    setStatus("Voice continuation failed; the controller state is preserved.", "error");
    pendingContinuation = undefined;
    return;
  }

  const job = pendingContinuation;
  job.attempts += 1;
  inFlightContinuation = { token: job.token, responseId: undefined, startTimer: undefined, meta: job.meta };
  reportClientEvent("state_advance_requested", { phase: "dispatched", token: job.token, attempt: job.attempts, ...job.meta });
  try {
    const overrides = job.meta?.continuityAware
      ? { ...job.overrides, instructions: `${job.overrides.instructions || ""}${buildContinuityInstruction({ lastCoach: lastCoachUtterance, lastUser: lastParticipantUtterance, state: job.meta.state || coachState, reason: job.meta.reason })}` }
      : job.overrides;
    requestResponse(overrides);
    inFlightContinuation.startTimer = setTimeout(() => {
      if (!inFlightContinuation || inFlightContinuation.token !== job.token || inFlightContinuation.responseId) return;
      reportClientEvent("state_advance_requested", { phase: "start_timeout", token: job.token, attempt: job.attempts, ...job.meta });
      inFlightContinuation = undefined;
      scheduleContinuationFlush(Math.min(1_000, 200 * job.attempts));
    }, 2_000);
  } catch (error) {
    inFlightContinuation = undefined;
    addLog("error", `Could not dispatch automatic continuation: ${error.message}`);
    scheduleContinuationFlush(Math.min(1_000, 200 * job.attempts));
  }
}

function handleResponseDone(response) {
  activeResponseIds.delete(response.id);
  if (handlePermanentRealtimeFailure(response)) return;
  if (inFlightContinuation?.responseId === response.id) {
    const token = inFlightContinuation.token;
    const completedMeta = inFlightContinuation.meta || {};
    clearTimeout(inFlightContinuation.startTimer);
    inFlightContinuation = undefined;
    const spoke = responsesWithSpokenOutput.has(response.id);
    responsesWithSpokenOutput.delete(response.id);
    if (response.status === "completed") {
      if (pendingContinuation?.token === token) pendingContinuation = undefined;
      setStatus("Connected to XTY Realtime — you can speak now.", "connected");
      reportClientEvent("state_advance_requested", { phase: "completed", token, response_id: response.id, state: coachState, accepted_incomplete_with_audio: false });
      if (["setup_ready", "setup_ready_with_reminder", "side_switch"].includes(completedMeta.reason)) {
        releasePendingMotionReplayAfterCue();
      } else if (completedMeta.reason === "perception_resume") {
        motionSupervisorPaused = false;
        motionManuallyPaused = Boolean(gvhmrReplay?.active);
        elements.motionPlayPause.disabled = false;
        elements.motionPlayPause.textContent = gvhmrReplay?.active ? "Resume motion" : "Play motion";
        renderMotionReplayStatus({ state: gvhmrReplay?.active ? "paused" : "ready", message: "Clarification complete. Resume motion manually when ready." });
      }
    } else {
      reportClientEvent("state_advance_requested", { phase: "retry", token, response_id: response.id, status: response.status, status_details: response.status_details, state: coachState });
      const retryDelay = retryDelayFromResponse(response);
      if (retryDelay !== undefined && pendingContinuation?.token === token) {
        pendingContinuation.attempts = Math.max(0, pendingContinuation.attempts - 1);
        pendingContinuation.rateLimitWaits += 1;
        const seconds = Math.ceil(retryDelay / 100) / 10;
        setStatus(`Realtime rate limit reached; continuing automatically in about ${seconds}s.`, "working");
        addLog("system", `Automatic voice continuation rate-limited; retrying in ${seconds}s without requiring speech.`);
        reportClientEvent("state_advance_requested", { phase: "rate_limit_wait", token, response_id: response.id, delay_ms: retryDelay, state: coachState });
        scheduleContinuationFlush(retryDelay);
        return;
      }
      if (response.status === "incomplete" && response.status_details?.reason === "max_output_tokens" && pendingContinuation?.token === token) {
        pendingContinuation.attempts = Math.max(0, pendingContinuation.attempts - 1);
        pendingContinuation.overrides = {
          instructions: "Finish only the interrupted coaching sentence in no more than 20 spoken words. Do not restart it, repeat earlier content, or add a new topic.",
          tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 500,
        };
        scheduleContinuationFlush(250);
        return;
      }
    }
  }
  const untrackedRetryDelay = retryDelayFromResponse(response);
  if (!inFlightContinuation && untrackedRetryDelay !== undefined && !pendingContinuation) {
    const seconds = Math.ceil(untrackedRetryDelay / 100) / 10;
    setStatus(`Realtime rate limit reached; answering automatically in about ${seconds}s.`, "working");
    queueContinuation({
      instructions: "Respond now to the participant's most recent unanswered turn. Do not ask them to repeat it. Continue naturally from the current Otago task card in one or two short sentences.",
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 700,
    }, { state: coachState, reason: "user_turn_rate_limit" }, untrackedRetryDelay);
    return;
  }
  scheduleContinuationFlush(response.status === "completed" ? 0 : Math.min(4_000, 500 * Math.max(1, pendingContinuation?.attempts || 1)));
}

function handlePermanentRealtimeFailure(response) {
  return handlePermanentRealtimeError(response?.status_details?.error);
}

function handlePermanentRealtimeError(error) {
  const code = String(error?.code || error?.type || "");
  if (!["credit_balance_exhausted", "insufficient_quota", "invalid_api_key"].includes(code)) return false;
  realtimeFatalError = { code, message: error.message || "Realtime service is unavailable." };
  clearTimeout(continuationRetryTimer);
  clearTimeout(inFlightContinuation?.startTimer);
  pendingContinuation = undefined;
  inFlightContinuation = undefined;
  activeResponseIds.clear();
  userSpeaking = false;
  sessionReady = false;
  microphoneStream?.getAudioTracks().forEach((track) => track.stop());
  const message = code === 'credit_balance_exhausted' || code === 'insufficient_quota'
    ? "XTY API credits are exhausted. Voice generation and ASR are unavailable; add credits, then start a new session."
    : "The XTY API key was rejected. Check XTY_API_KEY in .env, restart the server, and start a new session.";
  setStatus(message, "error");
  addLog("error", `${message} Provider detail: ${realtimeFatalError.message}`);
  elements.newSession.disabled = false;
  return true;
}

function retryDelayFromResponse(response) {
  const error = response?.status_details?.error;
  if (error?.code !== "rate_limit_exceeded") return undefined;
  const message = error.message || "";
  const seconds = message.match(/try again in\s+([0-9.]+)s/i);
  if (seconds) return Math.max(1_000, Math.ceil(Number(seconds[1]) * 1_000) + 350);
  const milliseconds = message.match(/try again in\s+([0-9.]+)ms/i);
  if (milliseconds) return Math.max(500, Math.ceil(Number(milliseconds[1])) + 350);
  return 5_000;
}

function requestResponse(overrides = {}) {
  addLog("system", `Realtime response requested for ${coachState}.`);
  sendEvent({ type: "response.create", response: createRealtimeResponseConfig(realtimeProtocol, overrides) });
}
function sendEvent(value) {
  if (value.type === "session.update") addLog("system", `Realtime state update sent: ${coachState}.`);
  if (["session.update", "response.create", "conversation.item.create"].includes(value.type)) {
    reportClientEvent("data_channel_sent", { type: value.type, item_type: value.item?.type, state: coachState });
  }
  assertSession();
  const serialized = JSON.stringify(value);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  const limit = dataChannelMaxMessageSize();
  if (bytes > limit) throw new Error(`Realtime relay message is ${formatBytes(bytes)}, exceeding the ${formatBytes(limit)} limit.`);
  dataChannel.send(serialized);
}

function reportClientEvent(kind, detail = {}) {
  if (!localSessionId) return;
  fetch(`/api/sessions/${localSessionId}/client-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, detail }),
    keepalive: true,
  }).catch(() => {});
}

export async function pushMotionEvent(rawEvent) {
  assertSession();
  const event = normalizeMotionEvent(bindMotionEventToCurrentTask(rawEvent));
  const errors = validateMotionEvent(event); if (errors.length) throw new Error(errors.join(" "));
  addLog(event.assessment.status, `${event.exercise.name}: ${event.assessment.summary || event.assessment.issues[0]?.summary || event.assessment.status}`);
  const response = await fetch(`/api/sessions/${localSessionId}/motion-event`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.result?.ok) throw new Error(payload.result?.error || payload.error || "Motion event rejected.");
  updateCoachState(payload.snapshot);
  if (payload.session_update && payload.result.sync_model_state !== false) sendEvent(payload.session_update);

  const progress = payload.result.motion_progress;
  const modelNeedsMotionResult = event.assessment.status !== "correct"
    || progress?.target_reached
    || payload.result.state_changed;
  if (modelNeedsMotionResult) {
    sendConversationText(`[MOTION_CONTROLLER_RESULT] ${JSON.stringify({
      action_id: event.exercise.id,
      status: event.assessment.status,
      phase: event.observation.phase,
      attention_mode: payload.result.attention?.mode,
      observed_count: progress?.observed_count,
      target_count: progress?.target_count,
      remaining_count: progress?.remaining_count,
      target_reached: progress?.target_reached,
      controller_state: payload.snapshot.current_state,
    })}`, false);
  } else if (payload.result.notify_model || (
    event.assessment.status === "correct"
    && ["rep_completed", "hold_completed"].includes(event.observation.phase)
    && Number.isFinite(progress?.observed_count)
  )) {
    sendConversationText(`[MOTION_PROGRESS] ${JSON.stringify({
      action_id: event.exercise.id,
      phase: event.observation.phase,
      observed_count: progress?.observed_count,
      target_count: progress?.target_count,
      remaining_count: progress?.remaining_count,
      unit: progress?.unit,
      elapsed_seconds: event.observation.metrics?.elapsed_seconds,
      controller_state: payload.snapshot.current_state,
    })}`, false);
  }

  if (payload.result.state_changed || String(payload.result.reason || "").startsWith("warm_up_motion")) {
    queueStateAdvance(payload.snapshot, payload.session_update, payload.result.reason);
  } else if (progress?.target_reached && coachState === "active_set") {
    queueContinuation({
      instructions: `The authoritative motion target is complete at ${progress.observed_count}/${progress.target_count}. Silently submit set_completed with count ${progress.target_count} now; do not ask the participant to confirm it.`,
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 300,
    }, { state: coachState, action: event.exercise.name, reason: "motion_target_reached" });
  } else if (payload.result.attention?.mode === "safety_check") {
    motionSupervisorPaused = true;
    gvhmrReplay?.pause("Possible safety event; waiting for participant confirmation.");
    elements.motionPlayPause.disabled = true;
    elements.motionPlayPause.textContent = "Paused for safety check";
    queueContinuation({
      instructions: `${payload.result.attention.question} Begin with a direct calm stop cue, then ask whether they are okay. Do not discuss counts or ask them to resume. If they do not clearly respond, use vision only as supporting visible evidence; never treat an image as proof that they are safe.`,
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 500,
    }, { state: coachState, action: event.exercise.name, reason: "motion_safety_check" });
  } else if (payload.result.attention?.mode === "vision") {
    const attention = payload.result.attention;
    queueContinuation({
      instructions: `The motion supervisor needs visual clarification before further coaching. Output only a capture_vision_snapshot function call with purpose="${attention.purpose || "motion_uncertainty"}", focus=${JSON.stringify(attention.focus || "the participant's current exercise and full-body framing")}, and reason=${JSON.stringify(attention.reason || "motion evidence is uncertain")}. Do not speak before the function call.`,
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 300,
    }, { state: coachState, action: event.exercise.name, reason: "motion_vision_escalation" });
  } else if (payload.result.attention?.mode === "voice_check") {
    queueContinuation({
      instructions: `${payload.result.attention.question} Keep it to one calm sentence. Do not claim the motion is complete and do not narrate system operations.`,
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 350,
    }, { state: coachState, action: event.exercise.name, reason: "motion_voice_escalation" });
  } else if (payload.result.attention?.mode === "coach_cue") {
    queueContinuation({
      instructions: `Give one brief, immediately actionable correction based only on this evidence: ${payload.result.attention.cue}. Do not mention counting, detection, logging, or internal state.`,
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 350,
    }, { state: coachState, action: event.exercise.name, reason: "motion_correction" });
  } else if (payload.result.attention?.mode === "recovery_ack") {
    queueContinuation({
      instructions: "Briefly confirm that the latest attempt improved, using no more than eight spoken words, then let the participant continue. Do not mention detection or internal state.",
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 250,
    }, { state: coachState, action: event.exercise.name, reason: "correction_improved" });
  } else if (payload.result.continue_response) {
    queueContinuation({
      instructions: "Address the motion concern now with one concise correction or safety response. Do not narrate counting or bookkeeping.",
      tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 500,
    }, { state: coachState, action: event.exercise.name, reason: "motion_attention" });
  }
  return event;
}

function bindMotionEventToCurrentTask(rawEvent = {}, { force = false } = {}) {
  const value = structuredClone(rawEvent);
  const placeholder = value.exercise?.id || value.exercise_id;
  if (!force && !["current_action", "current_exercise", "current_warm_up"].includes(placeholder)) return value;
  const action = coachState === "warm_up_sequence" ? latestCoachSnapshot?.current_warm_up : latestCoachSnapshot?.current_exercise;
  if (!action) return value;
  if (value.exercise && typeof value.exercise === "object") {
    value.exercise.id = action.id;
    value.exercise.name = action.name;
    value.exercise.side = latestCoachSnapshot?.current_set?.side || latestCoachSnapshot?.current_set?.direction || "not_applicable";
    value.exercise.rep_index = Number(latestCoachSnapshot?.observed_count || 0) + 1;
  } else {
    value.exercise_id = action.id;
    value.exercise_name = action.name;
    value.side = latestCoachSnapshot?.current_set?.side || latestCoachSnapshot?.current_set?.direction || "not_applicable";
    value.rep_index = Number(latestCoachSnapshot?.observed_count || 0) + 1;
  }
  return value;
}

function syncEditorEventToCurrentTask() {
  if (!latestCoachSnapshot) return;
  try {
    const current = JSON.parse(elements.eventJson.value);
    elements.eventJson.value = JSON.stringify(bindMotionEventToCurrentTask(current, { force: true }), null, 2);
  } catch {
    // Do not overwrite temporarily invalid JSON while the user is editing it.
  }
}

export async function pushPrescription(prescription) {
  pendingPrescription = prescription;
  elements.prescriptionJson.value = JSON.stringify(prescription, null, 2);
  if (sessionReady) await submitPrescription(prescription, true);
  return prescription;
}

async function submitPrescription(prescription, announce) {
  const response = await fetch(`/api/sessions/${localSessionId}/prescription`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prescription }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.result?.error || payload.error || "Prescription rejected.");
  updateCoachState(payload.snapshot);
  if (payload.session_update) sendEvent(payload.session_update);
  if (announce) addLog("system", `Prescription loaded: ${payload.snapshot.prescription_id}.`);
}

async function persistSessionLog(reason) {
  if (!localSessionId) return;
  try {
    const response = await fetch(`/api/sessions/${localSessionId}/end`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, conversation: conversationRecords }),
    });
    const payload = await response.json();
    if (response.ok) addLog("system", `Session log saved: ${payload.log_path?.split("/").pop() || "local JSON"}.`);
  } catch {
    addLog("error", "Could not save the local session log.");
  }
}

async function loadPrescriptionFromEditor() {
  try { await pushPrescription(JSON.parse(elements.prescriptionJson.value)); if (!sessionReady) addLog("system", "Prescription staged; it will load when the voice session starts."); }
  catch (error) { addLog("error", `Prescription rejected: ${error.message}`); }
}

async function sendEditorEvent() {
  if (editorMotionEventInFlight) return;
  editorMotionEventInFlight = true;
  elements.sendEvent.disabled = true;
  try {
    const raw = bindMotionEventToCurrentTask(JSON.parse(elements.eventJson.value), { force: true });
    await pushMotionEvent(raw);
    loadSelectedSample();
  } catch (error) {
    addLog("error", error.message);
  } finally {
    editorMotionEventInFlight = false;
    elements.sendEvent.disabled = false;
  }
}
function loadSelectedSample() {
  const sample = structuredClone(samples[elements.sample.value] || samples.correct);
  const action = coachState === "warm_up_sequence" ? latestCoachSnapshot?.current_warm_up : latestCoachSnapshot?.current_exercise;
  if (action) {
    sample.exercise_id = action.id; sample.exercise_name = action.name;
    sample.side = latestCoachSnapshot.current_set?.side || latestCoachSnapshot.current_set?.direction || "not_applicable";
    sample.rep_index = Number(latestCoachSnapshot.observed_count || 0) + 1;
  }
  elements.eventJson.value = JSON.stringify(sample, null, 2);
}

function toggleSensorSocket() {
  if (sensorSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(sensorSocket.readyState)) { sensorSocket.close(); return; }
  const url = elements.wsUrl.value.trim(); if (!url) return setSensorStatus("Enter a WebSocket URL.", "error");
  try {
    sensorSocket = new WebSocket(url); setSensorStatus("Connecting…", "working");
    sensorSocket.addEventListener("open", () => {
      gvhmrReplay?.setExternalStreamActive(true);
      gvhmrReplay?.sync(latestCoachSnapshot);
      setSensorStatus("Sensor connected — accepting raw SMPL-24 frames or semantic events.", "connected");
      elements.wsConnect.textContent = "Disconnect sensor";
    });
    sensorSocket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        const task = isRawJointFrame(payload) ? gvhmrReplay.processLiveFrame(payload) : pushMotionEvent(payload);
        void task.catch((error) => addLog("error", `Motion input rejected: ${error.message}`));
      }
      catch (error) { addLog("error", `Motion event rejected: ${error.message}`); }
    });
    sensorSocket.addEventListener("close", () => {
      gvhmrReplay?.setExternalStreamActive(false);
      setSensorStatus("Sensor disconnected.", "idle");
      elements.wsConnect.textContent = "Connect sensor";
    });
    sensorSocket.addEventListener("error", () => setSensorStatus("Sensor connection error.", "error"));
  } catch (error) { setSensorStatus(error.message, "error"); }
}

function isRawJointFrame(value) {
  return value?.type === "joint_frame"
    || Array.isArray(value?.joints3d_global)
    || Array.isArray(value?.joints_3d)
    || Array.isArray(value?.joints);
}

function assertSession() { if (!sessionReady || dataChannel?.readyState !== "open") throw new Error("Start the voice session before sending data."); }

function motionReplayKey(snapshot) {
  if (snapshot?.current_state !== "active_set") return null;
  const actionId = snapshot.current_exercise?.id;
  const setId = snapshot.current_set?.set_id;
  return actionId && setId ? `${snapshot.run_number}:${actionId}:${setId}` : null;
}

function releasePendingMotionReplayAfterCue() {
  clearTimeout(motionReplayReleaseTimer);
  const pending = pendingMotionReplay;
  if (!pending || motionReplayKey(latestCoachSnapshot) !== pending.key) return;
  pendingMotionReplay = undefined;
  gvhmrReplay?.sync(pending.snapshot);
  elements.motionPlayPause.disabled = false;
  elements.motionPlayPause.textContent = "Play motion";
}

function syncGvhmrReplayWithCoach(snapshot) {
  const key = motionReplayKey(snapshot);
  if (!key) {
    pendingMotionReplay = undefined;
    gvhmrReplay?.sync(snapshot);
    motionManuallyPaused = false;
    elements.motionPlayPause.disabled = true;
    elements.motionPlayPause.textContent = "Pause motion";
    return;
  }
  if (gvhmrReplay?.active?.key === key) return;
  pendingMotionReplay = undefined;
  gvhmrReplay?.sync(snapshot);
  elements.motionPlayPause.disabled = false;
  elements.motionPlayPause.textContent = "Play motion";
  renderMotionReplayStatus({
    state: "ready",
    message: `Motion input ready for ${snapshot.current_exercise?.name || "the current set"}. Choose an input if needed, then press Play motion.`,
  });
}

function togglePresentationPause() {
  if (!sessionReady) return;
  presentationPaused = !presentationPaused;
  microphoneStream?.getAudioTracks().forEach((track) => { track.enabled = !presentationPaused; });
  elements.audio.muted = presentationPaused;
  elements.pausePresentation.textContent = presentationPaused ? "Resume presentation" : "Pause presentation";
  elements.pausePresentation.setAttribute("aria-pressed", String(presentationPaused));
  if (presentationPaused) {
    gvhmrReplay?.pause("Presentation paused. Microphone uplink and motion replay are suspended.");
    addLog("system", "Presentation paused; microphone uplink disabled and motion replay frozen.");
    setStatus("Presentation paused — discussion audio is not sent to the agent.", "warning");
    return;
  }
  addLog("system", "Presentation resumed; microphone uplink restored.");
  setStatus("Presentation resumed — you can speak to the agent.", "connected");
  if (!motionManuallyPaused) {
    if (gvhmrReplay?.active) gvhmrReplay.resume();
    else if (pendingMotionReplay) releasePendingMotionReplayAfterCue();
  }
  scheduleContinuationFlush(0);
}

function toggleMotionPause() {
  if (!sessionReady) return;
  if (!gvhmrReplay?.active) {
    if (presentationPaused || motionSupervisorPaused || coachState !== "active_set") return;
    motionManuallyPaused = false;
    try {
      gvhmrReplay.replayCurrent();
      elements.motionPlayPause.textContent = "Pause motion";
    } catch (error) {
      renderMotionReplayStatus({ state: "error", message: error.message });
    }
    return;
  }
  motionManuallyPaused = !motionManuallyPaused;
  elements.motionPlayPause.textContent = motionManuallyPaused ? "Resume motion" : "Pause motion";
  elements.motionPlayPause.setAttribute("aria-pressed", String(motionManuallyPaused));
  if (motionManuallyPaused) {
    gvhmrReplay?.pause("Motion replay paused. Voice remains active; you can ask the coach about the current count.");
    return;
  }
  if (presentationPaused) return;
  if (gvhmrReplay?.active) gvhmrReplay.resume();
  else if (pendingMotionReplay) releasePendingMotionReplayAfterCue();
}

function updateCoachState(snapshot) {
  if (!snapshot) return; latestCoachSnapshot = snapshot; coachState = snapshot.current_state || coachState;
  elements.coachState.textContent = `${snapshot.state_label || coachState} (${coachState})`;
  elements.stateBanner.textContent = snapshot.state_label || coachState;
  elements.stateBanner.dataset.state = coachState;
  const action = actionForSnapshot(snapshot);
  const set = snapshot.current_set?.set_id ? ` · set ${snapshot.current_set.set_id}` : "";
  const count = coachState === "active_set"
    ? ` · count ${snapshot.observed_count || 0}/${setTargetFromSnapshot(snapshot.current_set)}`
    : coachState === "warm_up_sequence"
      ? ` · count ${snapshot.observed_count || 0}/${warmUpTargetFromSnapshot(snapshot.current_warm_up)}`
      : "";
  elements.stateDetail.textContent = action ? `Current item: ${action}${set}${count}` : `Run ${snapshot.run_number || 1} · compact controller cursor is authoritative.`;
  elements.coachingStyle.textContent = `${snapshot.communication_policy?.phase || "program-based"} · ${snapshot.communication_policy?.default_detail || "adaptive detail"}`;
  if (elements.motionAwareness) elements.motionAwareness.textContent = JSON.stringify(snapshot.motion_awareness || { activity: "not_available" }, null, 2);
  const review = snapshot.clinician_reviewed ? "clinician reviewed" : "SIMULATED — not clinician reviewed";
  elements.prescriptionStatus.textContent = `${snapshot.prescription_id} · ${snapshot.prescription_version} · ${review}`;
  const rangeContext = `${snapshot.current_exercise?.id || "none"}:${snapshot.current_set?.set_id || "none"}`;
  if (rangeContext !== lastSuggestedRangeContext) {
    lastSuggestedRangeContext = rangeContext;
    updateRawSequenceRange();
  }
  syncEditorEventToCurrentTask();
  syncRestTimer(snapshot);
  syncGvhmrReplayWithCoach(snapshot);
}

function syncRestTimer(snapshot, force = false) {
  if (snapshot.current_state !== "rest" || !sessionReady) {
    clearTimeout(restAdvanceTimer); restAdvanceTimer = undefined; scheduledRestKey = undefined;
    return;
  }
  const key = `${localSessionId}:${snapshot.run_number}:${snapshot.exercise_index}`;
  if (!force && scheduledRestKey === key && restAdvanceTimer) return;
  clearTimeout(restAdvanceTimer);
  scheduledRestKey = key;
  const seconds = Math.max(0, Number(snapshot.rest_between_exercises_seconds ?? 15));
  addLog("system", `Inter-exercise rest timer started: ${seconds} seconds.`);
  restAdvanceTimer = setTimeout(async () => {
    if (!sessionReady || coachState !== "rest" || scheduledRestKey !== key) return;
    restAdvanceTimer = undefined;
    try {
      const routed = await autoRouteFromRest();
      if (routed.result?.continue_response) queueStateAdvance(routed.snapshot, routed.session_update, "timed_rest_complete");
    } catch (error) {
      addLog("error", `Could not continue after the short rest: ${error.message}`);
    }
  }, seconds * 1_000);
}
function setTargetFromSnapshot(setSpec = {}) {
  return Number(setSpec.repetitions || setSpec.steps || setSpec.patterns || (setSpec.hold_seconds ? 1 : 1));
}
function warmUpTargetFromSnapshot(action = {}) {
  return Number(action.repetitions_each_side || action.repetitions || (action.hold_seconds ? 1 : 1));
}
function addTranscript(speaker, text) {
  if (!text?.trim()) return; elements.transcript.querySelector(".placeholder")?.remove();
  const normalized = text.trim();
  if (speaker === "Coach") lastCoachUtterance = normalized;
  if (speaker === "You") lastParticipantUtterance = normalized;
  conversationRecords.push({ at: new Date().toISOString(), speaker, text: normalized });
  const item = document.createElement("div"); item.className = `transcript-item ${speaker.toLowerCase()}`;
  const label = document.createElement("strong"); label.textContent = speaker; const content = document.createElement("span"); content.textContent = normalized;
  item.append(label, content); elements.transcript.append(item); elements.transcript.scrollTop = elements.transcript.scrollHeight;
}
function addLog(kind, text) { const item = document.createElement("li"); item.className = `log-${kind}`; item.textContent = `${new Date().toLocaleTimeString()} — ${text}`; elements.eventLog.prepend(item); }
function setStatus(text, kind) { elements.status.textContent = text; elements.status.dataset.kind = kind; }
function setSensorStatus(text, kind) { elements.wsStatus.textContent = text; elements.wsStatus.dataset.kind = kind; }
function setCameraStatus(text, kind) { elements.cameraStatus.textContent = text; elements.cameraStatus.dataset.kind = kind; }

window.otago = { pushMotionEvent, pushPrescription, get connectionState() { return sessionReady ? "connected" : "closed"; }, get state() { return coachState; } };
