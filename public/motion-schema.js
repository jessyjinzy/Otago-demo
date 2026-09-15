const statuses = new Set(["correct", "needs_correction", "safety_concern", "uncertain"]);
const severities = new Set(["info", "low", "moderate", "high", "critical"]);

export function normalizeMotionEvent(input = {}) {
  const assessmentInput = input.assessment || {};
  const observationInput = input.observation || {};
  const exerciseInput = input.exercise || {};
  const status = statuses.has(assessmentInput.status || input.status)
    ? assessmentInput.status || input.status
    : "uncertain";

  const rawIssues = assessmentInput.issues || input.issues || (input.issue_code ? [input] : []);
  const issues = rawIssues.map((issue) => ({
    code: String(issue.code || issue.issue_code || "unspecified"),
    severity: severities.has(issue.severity) ? issue.severity : "moderate",
    confidence: clampConfidence(issue.confidence),
    summary: String(issue.summary || issue.message || "").trim(),
  }));

  const requiresResponse =
    assessmentInput.requires_response ??
    input.requires_response ??
    status !== "correct";

  return {
    schema_version: "0.1",
    event_id: String(input.event_id || `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    timestamp_ms: Number(input.timestamp_ms || Date.now()),
    session_id: String(input.session_id || "demo-session"),
    participant_id: input.participant_id ? String(input.participant_id) : undefined,
    exercise: {
      id: String(exerciseInput.id || input.exercise_id || "unknown_exercise"),
      name: String(exerciseInput.name || input.exercise_name || exerciseInput.id || input.exercise_id || "Unknown exercise"),
      level: String(exerciseInput.level || input.level || "unspecified"),
      side: String(exerciseInput.side || input.side || "not_applicable"),
      rep_index: nullableNumber(exerciseInput.rep_index ?? input.rep_index),
    },
    observation: {
      phase: String(observationInput.phase || input.phase || "unspecified"),
      confidence: clampConfidence(observationInput.confidence ?? input.confidence),
      valid_count_increment: nonnegativeInteger(observationInput.valid_count_increment ?? input.valid_count_increment ?? defaultCountIncrement(status, observationInput.phase || input.phase)),
      metrics: sanitizePerceptionMetrics(observationInput.metrics || input.metrics || {}),
    },
    assessment: {
      status,
      issues,
      requires_response: Boolean(requiresResponse),
      summary: String(assessmentInput.summary || input.summary || "").trim(),
    },
    user_state: input.user_state || {},
  };
}

function sanitizePerceptionMetrics(value) {
  if (Array.isArray(value)) return value.map(sanitizePerceptionMetrics);
  if (!value || typeof value !== "object") return value;
  const blocked = new Set([
    "clip_id", "source_clip_id", "source_label", "source_action_id",
    "source_segment_id", "recorded_source_time_s", "replay_source", "replay_fault",
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.has(key) && !key.startsWith("replay_"))
    .map(([key, item]) => [key, sanitizePerceptionMetrics(item)]));
}

export function validateMotionEvent(event) {
  const errors = [];
  if (!event || typeof event !== "object") return ["Event must be a JSON object."];
  if (!event.exercise?.id) errors.push("exercise.id is required.");
  if (!statuses.has(event.assessment?.status)) {
    errors.push("assessment.status must be correct, needs_correction, safety_concern, or uncertain.");
  }
  if (!Number.isFinite(event.timestamp_ms)) errors.push("timestamp_ms must be a number.");
  if (!Number.isInteger(event.observation?.valid_count_increment) || event.observation.valid_count_increment < 0) errors.push("observation.valid_count_increment must be a nonnegative integer.");
  return errors;
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function defaultCountIncrement(status, phase = "") {
  return status === "correct" && /(?:rep|step|hold|trial|pattern|set)_completed/i.test(String(phase)) ? 1 : 0;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}
