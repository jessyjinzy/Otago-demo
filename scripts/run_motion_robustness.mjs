#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGvhmrDetector, GlobalMotionMonitor, GvhmrReplayEngine } from "../public/gvhmr-motion.js";
import { createOtagoController, DEMO_PRESCRIPTION } from "../simplified-controller.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(process.env.GVHMR_OUTPUT_ROOT || resolve(projectRoot, ".."));
const extractor = resolve(projectRoot, "scripts/extract_gvhmr_sequence.py");
const fixture = JSON.parse(readFileSync(resolve(projectRoot, "public/motion-data/gvhmr-demo.json"), "utf8"));

const raw = {
  knee: extract("output1/back_extension_knee_bends", 20, 37, 10),
  oneLegLeft: extract("output2/heel_toe_standing_one_leg_stand", 33.5, 46.5, 5),
  oneLegRight: extract("output2/heel_toe_standing_one_leg_stand", 47.5, 59, 5),
  walking10: extract("output1/backwards_walking_heel_toe_walking_forwards_backwards", 0, 20, 10),
  walking5: extract("output1/backwards_walking_heel_toe_walking_forwards_backwards", 0, 20, 5),
};

const kneeAction = { id: "knee_bends", name: "Knee bends", ...fixture.actions.knee_bends };
const oneLegAction = { id: "one_leg_stand", name: "One-leg stand", ...fixture.actions.one_leg_stand };
const kneeSegment = { ...fixture.actions.knee_bends.segments[0], frames: rebase(raw.knee) };
const oneLegLeftSegment = { ...fixture.actions.one_leg_stand.segments[0], frames: rebase(raw.oneLegLeft) };
const oneLegRightSegment = { ...fixture.actions.one_leg_stand.segments[1], frames: rebase(raw.oneLegRight) };

const kneeTwoReps = prefixThroughMilestone(kneeAction, kneeSegment, "rep_completed", 2);
const oneLegFourSeconds = prefixIntoHold(oneLegAction, oneLegLeftSegment, 4);
const walkingForKnee = rebase(raw.walking10);
const walkingForOneLeg = rebase(raw.walking5);

const scenarios = [
  scenario("KB-01", "knee_bends", "Baseline: five recorded knee bends", kneeAction, kneeSegment, kneeSegment.frames, { kind: "baseline", expectedCount: 5 }),
  scenario("KB-02", "knee_bends", "Two correct reps, then a different walking sequence", kneeAction, kneeSegment,
    cascade(kneeTwoReps, walkingForKnee.slice(0, 120)), { kind: "wrong_activity", expectedMaximumCount: 2, visual: "wrong_exercise" }),
  scenario("KB-03", "knee_bends", "Two correct reps, then 12 seconds standing still", kneeAction, kneeSegment,
    cascade(kneeTwoReps, staticTail(kneeTwoReps.at(-1), 12, 10)), { kind: "stopped", expectedMaximumCount: 2, visual: "resting" }),
  scenario("KB-04", "knee_bends", "Wrong movement for the whole set: one-leg recording", kneeAction, kneeSegment,
    rebase(oneLegLeftSegment.frames), { kind: "wrong_activity", expectedMaximumCount: 0, visual: "wrong_exercise" }),
  scenario("KB-05", "knee_bends", "Two-second lower-body occlusion", kneeAction, kneeSegment,
    faultWindow(kneeSegment.frames, "occlusion", 0.3, 0.45), { kind: "tracking_fault", visual: "partially_occluded" }),
  scenario("KB-06", "knee_bends", "Two-second low tracking confidence", kneeAction, kneeSegment,
    faultWindow(kneeSegment.frames, "low_confidence", 0.3, 0.45), { kind: "tracking_fault", visual: "tracking_failure" }),
  scenario("KB-07", "knee_bends", "Drop every fourth frame", kneeAction, kneeSegment,
    kneeSegment.frames.filter((_, index) => index % 4 !== 0), { kind: "persistent_frame_loss", expectedMaximumCount: 5, visual: "tracking_failure" }),
  scenario("KB-08", "knee_bends", "Two-second timestamp/stream gap", kneeAction, kneeSegment,
    timestampGap(kneeSegment.frames, 2), { kind: "stream_gap", visual: "tracking_failure" }),

  scenario("OLS-01", "one_leg_stand", "Baseline: recorded left one-leg hold", oneLegAction, oneLegLeftSegment, oneLegLeftSegment.frames, { kind: "baseline", expectedCount: 1 }),
  scenario("OLS-02", "one_leg_stand", "Four valid hold seconds, then a different walking sequence", oneLegAction, oneLegLeftSegment,
    cascade(oneLegFourSeconds, walkingForOneLeg.slice(0, 60)), { kind: "wrong_activity", expectedMaximumCount: 0, visual: "wrong_exercise" }),
  scenario("OLS-03", "one_leg_stand", "Four valid hold seconds, then 12 seconds back in two-foot stance", oneLegAction, oneLegLeftSegment,
    cascade(oneLegFourSeconds, staticTail(kneeSegment.frames[0], 12, 5)), { kind: "stopped", expectedMaximumCount: 0, visual: "resting" }),
  scenario("OLS-04", "one_leg_stand", "Wrong movement for the whole set: knee-bend recording", oneLegAction, oneLegLeftSegment,
    rebase(kneeSegment.frames), { kind: "wrong_activity", expectedMaximumCount: 0, visual: "wrong_exercise" }),
  scenario("OLS-05", "one_leg_stand", "Two-second lower-body occlusion", oneLegAction, oneLegLeftSegment,
    faultWindow(oneLegLeftSegment.frames, "occlusion", 0.3, 0.48), { kind: "tracking_fault", visual: "partially_occluded" }),
  scenario("OLS-06", "one_leg_stand", "Two-second low tracking confidence", oneLegAction, oneLegLeftSegment,
    faultWindow(oneLegLeftSegment.frames, "low_confidence", 0.3, 0.48), { kind: "tracking_fault", visual: "tracking_failure" }),
  scenario("OLS-07", "one_leg_stand", "Drop every fourth frame", oneLegAction, oneLegLeftSegment,
    oneLegLeftSegment.frames.filter((_, index) => index % 4 !== 0), { kind: "persistent_frame_loss", expectedMaximumCount: 1, visual: "tracking_failure" }),
  scenario("OLS-08", "one_leg_stand", "Two-second timestamp/stream gap", oneLegAction, oneLegLeftSegment,
    timestampGap(oneLegLeftSegment.frames, 2), { kind: "stream_gap", visual: "tracking_failure" }),
  scenario("OLS-10", "one_leg_stand", "Baseline: recorded right one-leg hold", oneLegAction, oneLegRightSegment, oneLegRightSegment.frames, { kind: "baseline", expectedCount: 1 }),
];

const results = scenarios.map(runScenario);
results.push(
  await runWatchdogScenario("KB-09", "knee_bends", "Five-second delay before the first joint frame"),
  await runWatchdogScenario("OLS-09", "one_leg_stand", "Five-second delay before the first joint frame"),
);
console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  source_root: sourceRoot,
  raw_files: [
    "output1/back_extension_knee_bends/joints3d_global.npy",
    "output2/heel_toe_standing_one_leg_stand/joints3d_global.npy",
    "output1/backwards_walking_heel_toe_walking_forwards_backwards/joints3d_global.npy",
  ],
  implementation_scope: "Deterministic joint detector + global/open-world supervisor + local controller. Realtime voice wording is not invoked.",
  results,
}, null, 2));

function scenario(id, exerciseId, name, action, segment, frames, expectation) {
  return { id, exerciseId, name, action, segment: { ...segment, frames }, frames, expectation };
}

function delayedScenario(id, exerciseId, name, action, segment, frames, delaySeconds, expectedCount) {
  return scenario(id, exerciseId, name, action, segment, frames, {
    kind: "startup_delay", expectedCount, delaySeconds,
  });
}

async function runWatchdogScenario(id, exerciseId, name) {
  const events = [];
  const exercise = DEMO_PRESCRIPTION.exercises.find((item) => item.id === exerciseId);
  const set = exercise.set_sequence[0];
  const controller = activeController(exerciseId, set.set_id);
  const attentionPath = [];
  const engine = new GvhmrReplayEngine({
    dataUrl: "unused",
    pushEvent: async (event) => {
      events.push(event);
      const result = controller.recordMotionEvent(event);
      if (result.attention?.mode && result.attention.mode !== "none") attentionPath.push(result.attention.mode);
    },
    watchdogThresholdMs: 15,
  });
  engine.dataset = fixture;
  const snapshot = {
    current_state: "active_set", run_number: 1, observed_count: 0,
    current_exercise: exercise, current_set: set,
  };
  const resolved = { ...engine.resolve(snapshot), startupDelayMs: 100 };
  await engine.start(resolved);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  engine.stop();
  const stall = events.find((event) => event.observation.phase === "stream_stalled");
  const controllerSnapshot = controller.snapshot();
  return {
    id, exercise: exerciseId, scenario: name, input_frames: 0,
    detector_correct_completions: 0, detector_invalid_completions: 0,
    controller_accepted_count: controllerSnapshot.observed_count,
    counting_enabled_at_end: controllerSnapshot.motion_awareness.counting_enabled,
    first_alert_source_time_s: null,
    global_alerts: stall ? ["stream_stalled"] : [], open_world_activities: [],
    attention_path: [...new Set(attentionPath)], startup_silence_observed_by_controller: Boolean(stall),
    result: stall && !controllerSnapshot.motion_awareness.counting_enabled && controllerSnapshot.observed_count === 0 ? "PASS" : "LIMITATION",
    interpretation: stall && !controllerSnapshot.motion_awareness.counting_enabled
      ? "The wall-clock stream watchdog emitted one uncertainty event before any frame arrived; no progress was fabricated."
      : "The stream-stall event did not fully freeze authoritative progress.",
    event_phases: stall ? ["stream_stalled"] : [],
  };
}

function runScenario(spec) {
  const detector = createGvhmrDetector(spec.action, spec.segment);
  const monitor = new GlobalMotionMonitor(spec.action, spec.segment);
  const controller = activeController(spec.exerciseId, spec.segment.set_id);
  const eventPhases = [];
  const globalAlerts = [];
  const openWorldActivities = [];
  const attentionPath = [];
  let visualApplied = false;
  let detectorCorrectCompletions = 0;
  let detectorInvalidCompletions = 0;
  let firstAlertAt = null;

  for (const frame of spec.frames) {
    const gate = monitor.preflight(frame);
    const actionResult = gate.blocked ? { telemetry: monitor.invalidFrameTelemetry(frame), events: [] } : detector.process(frame);
    const monitorEvents = gate.blocked ? gate.events : monitor.inspect(frame, actionResult.telemetry, actionResult.events, { preflightDone: true });
    const events = monitorEvents.some((event) => event.observation.phase === "possible_fall")
      ? monitorEvents : [...monitorEvents, ...actionResult.events];
    for (const event of events) {
      const phase = event.observation.phase;
      eventPhases.push(phase);
      if (["rep_completed", "hold_completed"].includes(phase)) {
        if (event.assessment.status === "correct") detectorCorrectCompletions += 1;
        else detectorInvalidCompletions += 1;
      }
      if (["tracking_lost", "tracking_unreliable", "frame_loss", "stream_gap", "identity_changed", "possible_fall", "activity_hypothesis"].includes(phase)) {
        globalAlerts.push(phase);
        if (firstAlertAt === null) firstAlertAt = Number(frame.source_time_s.toFixed(2));
      }
      const activity = event.observation.metrics?.activity_supervisor?.activity;
      if (activity) openWorldActivities.push(activity);
      const result = controller.recordMotionEvent(event);
      if (result.attention?.mode && result.attention.mode !== "none") attentionPath.push(result.attention.mode);
      if (!visualApplied && result.attention?.mode === "vision" && spec.expectation.visual) {
        visualApplied = true;
        const visual = applyGroundTruthVision(controller, spec.expectation.visual);
        if (visual.attention?.mode && visual.attention.mode !== "none") attentionPath.push(`vision→${visual.attention.mode}`);
      }
    }
  }

  const snapshot = controller.snapshot();
  const delayBlindSpot = spec.expectation.kind === "startup_delay";
  const uniqueAlerts = [...new Set(globalAlerts)];
  const uniqueActivities = [...new Set(openWorldActivities)];
  const pass = evaluate(spec.expectation, snapshot.observed_count, uniqueAlerts, attentionPath);
  return {
    id: spec.id,
    exercise: spec.exerciseId,
    scenario: spec.name,
    input_frames: spec.frames.length,
    detector_correct_completions: detectorCorrectCompletions,
    detector_invalid_completions: detectorInvalidCompletions,
    controller_accepted_count: snapshot.observed_count,
    counting_enabled_at_end: snapshot.motion_awareness.counting_enabled,
    first_alert_source_time_s: firstAlertAt,
    global_alerts: uniqueAlerts,
    open_world_activities: uniqueActivities,
    attention_path: [...new Set(attentionPath)],
    startup_silence_observed_by_controller: delayBlindSpot ? false : null,
    result: pass.ok ? "PASS" : "LIMITATION",
    interpretation: pass.reason,
    event_phases: [...new Set(eventPhases)],
  };
}

function evaluate(expectation, count, alerts, attentionPath) {
  const requestedVision = attentionPath.includes("vision");
  if (expectation.kind === "baseline") return count === expectation.expectedCount && alerts.length === 0
    ? { ok: true, reason: "Reached the prescribed count without a supervisory false alarm." }
    : { ok: false, reason: `Expected count ${expectation.expectedCount} with no alert; observed ${count} and ${alerts.join(", ") || "no alert"}.` };
  if (expectation.kind === "recoverable_dropout") return count === expectation.expectedCount && alerts.length === 0
    ? { ok: true, reason: "Intermittent dropped frames preserved the correct result without a false alert." }
    : { ok: false, reason: `Intermittent dropout changed progress: count ${count}; alerts ${alerts.join(", ") || "none"}.` };
  if (expectation.kind === "persistent_frame_loss") return count <= expectation.expectedMaximumCount && alerts.includes("frame_loss") && requestedVision
    ? { ok: true, reason: "Persistent frame loss stopped trusted progress and escalated to the participant camera." }
    : { ok: false, reason: `Persistent frame loss was not fully escalated; count=${count}, alerts=${alerts.join(", ") || "none"}, vision=${requestedVision}.` };
  if (expectation.kind === "wrong_activity" || expectation.kind === "stopped") {
    const noFalseCount = count <= expectation.expectedMaximumCount;
    return requestedVision && noFalseCount
      ? { ok: true, reason: "Stopped accepting progress and requested visual clarification without adding false repetitions/holds." }
      : { ok: false, reason: `Expected a visual clarification and count ≤${expectation.expectedMaximumCount}; vision=${requestedVision}, count=${count}.` };
  }
  if (expectation.kind === "tracking_fault") return alerts.some((item) => ["tracking_lost", "tracking_unreliable"].includes(item)) && requestedVision
    ? { ok: true, reason: "Blocked corrupted frames and escalated the sustained tracking fault to vision." }
    : { ok: false, reason: `Tracking fault was not fully escalated; alerts=${alerts.join(", ") || "none"}, vision=${requestedVision}.` };
  if (expectation.kind === "stream_gap") return alerts.includes("stream_gap") && requestedVision
    ? { ok: true, reason: "Detected the timestamp discontinuity, blocked the affected frame, and requested visual clarification." }
    : { ok: false, reason: `Stream gap response incomplete; alerts=${alerts.join(", ") || "none"}, vision=${requestedVision}.` };
  if (expectation.kind === "startup_delay") return {
    ok: false,
    reason: `A ${expectation.delaySeconds}-second period with no incoming frame is invisible to this frame-driven supervisor. Once frames arrive, the baseline still reaches ${count}/${expectation.expectedCount}.`,
  };
  return { ok: false, reason: "No criterion configured." };
}

function applyGroundTruthVision(controller, activity) {
  return controller.execute("submit_visual_observation", {
    activity,
    confidence: 0.9,
    person_visible: !["left_frame", "tracking_failure"].includes(activity),
    full_body_visible: !["partially_occluded", "tracking_failure", "left_frame"].includes(activity),
    expected_exercise_visible: activity === "performing_expected_exercise",
    safety_concern_visible: activity === "possible_fall" || activity === "unstable_recovery",
    evidence: [`Robustness harness ground truth: ${activity}.`],
  });
}

function activeController(exerciseId, setId) {
  const sourceExercise = structuredClone(DEMO_PRESCRIPTION.exercises.find((item) => item.id === exerciseId));
  sourceExercise.set_sequence = [sourceExercise.set_sequence.find((item) => item.set_id === setId) || sourceExercise.set_sequence[0]];
  const prescription = {
    ...structuredClone(DEMO_PRESCRIPTION),
    prescription_id: `ROBUSTNESS-${exerciseId}`,
    exercises: [sourceExercise],
  };
  const controller = createOtagoController({ prescription });
  controller.execute("submit_session_event", { event: "greeting_ready" });
  controller.execute("submit_session_event", { event: "prepare_exercise" });
  controller.execute("submit_session_event", { event: "set_readiness_result", status: "ready", evidence: ["test_harness"] });
  return controller;
}

function extract(sequenceId, startSeconds, endSeconds, fps) {
  const output = execFileSync("python3", [
    extractor, "--source-root", sourceRoot, "--sequence-id", sequenceId,
    "--start-s", String(startSeconds), "--end-s", String(endSeconds), "--analysis-fps", String(fps),
  ], { encoding: "utf8", maxBuffer: 24 * 1024 * 1024 });
  return JSON.parse(output).actions.source_sequence.segments[0].frames;
}

function rebase(frames, startTime = 0, anchorPelvis = null) {
  if (!frames.length) return [];
  const firstTime = frames[0].source_time_s;
  const firstPelvis = frames[0].joints.pelvis;
  const target = anchorPelvis || firstPelvis;
  const offset = target.map((value, axis) => value - firstPelvis[axis]);
  return frames.map((source, index) => {
    const frame = structuredClone(source);
    frame.source_time_s = Number((startTime + source.source_time_s - firstTime).toFixed(4));
    frame.source_frame = index;
    for (const point of Object.values(frame.joints)) for (let axis = 0; axis < 3; axis += 1) point[axis] += offset[axis];
    return frame;
  });
}

function cascade(first, second) {
  const prefix = structuredClone(first);
  const step = prefix.length > 1 ? prefix.at(-1).source_time_s - prefix.at(-2).source_time_s : 0.1;
  const suffix = rebase(second, prefix.at(-1).source_time_s + step, prefix.at(-1).joints.pelvis);
  return [...prefix, ...suffix];
}

function prefixThroughMilestone(action, segment, phase, targetCount) {
  const detector = createGvhmrDetector(action, segment);
  let count = 0;
  for (let index = 0; index < segment.frames.length; index += 1) {
    const result = detector.process(segment.frames[index]);
    count += result.events.filter((event) => event.observation.phase === phase).length;
    if (count >= targetCount) return segment.frames.slice(0, index + 1);
  }
  throw new Error(`Could not find ${targetCount} ${phase} milestones.`);
}

function prefixIntoHold(action, segment, seconds) {
  const detector = createGvhmrDetector(action, segment);
  let startIndex = -1;
  for (let index = 0; index < segment.frames.length; index += 1) {
    if (detector.process(segment.frames[index]).events.some((event) => event.observation.phase === "hold_started")) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) throw new Error("Could not locate hold_started.");
  return segment.frames.slice(0, Math.min(segment.frames.length, startIndex + Math.round(seconds * action.analysis_fps)));
}

function staticTail(poseFrame, seconds, fps) {
  const frames = [];
  for (let index = 1; index <= Math.round(seconds * fps); index += 1) {
    const frame = structuredClone(poseFrame);
    frame.source_time_s = index / fps;
    frame.source_frame = index;
    frames.push(frame);
  }
  return frames;
}

function faultWindow(frames, kind, startRatio, endRatio) {
  return frames.map((source, index) => {
    const frame = structuredClone(source);
    const affected = index >= Math.floor(frames.length * startRatio) && index < Math.ceil(frames.length * endRatio);
    if (!affected) return frame;
    if (kind === "low_confidence") frame.tracking_confidence = 0.25;
    if (kind === "occlusion") {
      for (const joint of ["left_knee", "right_knee", "left_ankle", "right_ankle", "left_foot", "right_foot"]) delete frame.joints[joint];
    }
    return frame;
  });
}

function timestampGap(frames, gapSeconds) {
  const pivot = Math.floor(frames.length / 2);
  return frames.map((source, index) => {
    const frame = structuredClone(source);
    if (index >= pivot) frame.source_time_s += gapSeconds;
    return frame;
  });
}
