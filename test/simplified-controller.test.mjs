import test from "node:test";
import assert from "node:assert/strict";
import { createOtagoController, DEMO_PRESCRIPTION } from "../simplified-controller.mjs";

const event = (controller, name, extra = {}) => controller.execute("submit_session_event", { event: name, ...extra });

function passReadiness(controller) {
  assert.equal(event(controller, "greeting_ready").current_state, "readiness_check");
  assert.equal(event(controller, "readiness_completed", {
    no_warning_symptoms: true,
    illness_cleared: true,
    equipment_ready: true,
    environment_clear: true,
  }).current_state, "plan_briefing");
}

function controllerWithOpeningChecks() {
  return createOtagoController({ prescription: { ...DEMO_PRESCRIPTION, fast_demo_skip_opening_checks: false } });
}

function reachActiveSet(controller) {
  passReadiness(controller);
  assert.equal(event(controller, "plan_understood").current_state, "exercise_intro");
  assert.equal(event(controller, "prepare_exercise").current_state, "set_readiness");
  assert.equal(event(controller, "set_readiness_result", { status: "ready", evidence: ["vision", "user_report"] }).current_state, "active_set");
}

const motion = (controller, actionId, count = 1, status = "correct") => controller.recordMotionEvent({
  exercise: { id: actionId, name: actionId },
  observation: { phase: "rep_completed", valid_count_increment: count, confidence: 0.95 },
  assessment: { status, summary: "test motion" },
});

const intermediateMotion = (controller, phase, elapsedSeconds = 0) => controller.recordMotionEvent({
  exercise: { id: "knee_bends", name: "Knee bends" },
  observation: { phase, valid_count_increment: 0, confidence: 0.94, metrics: { elapsed_seconds: elapsedSeconds } },
  assessment: { status: "correct", summary: "in progress" },
});

test("demo prescription contains only the two GVHMR-backed actions", () => {
  assert.deepEqual(DEMO_PRESCRIPTION.warm_up, []);
  assert.deepEqual(DEMO_PRESCRIPTION.exercises.map((item) => item.id), ["knee_bends", "one_leg_stand"]);
  assert.equal(DEMO_PRESCRIPTION.allow_warm_up_omission_for_technical_demo, true);
});

test("explicit motion-replay demo skips warm-up and reaches the first exercise", () => {
  const controller = controllerWithOpeningChecks();
  passReadiness(controller);
  const result = event(controller, "plan_understood");
  assert.equal(result.current_state, "exercise_intro");
  assert.equal(result.reason, "prescribed_warm_up_omitted");
  assert.equal(controller.snapshot().current_exercise.id, "knee_bends");
});

test("default two-action session restores greeting, readiness, and plan briefing", () => {
  const controller = createOtagoController();
  const result = event(controller, "greeting_ready");
  assert.equal(result.current_state, "readiness_check");
  const ready = event(controller, "readiness_completed", {
    no_warning_symptoms: true,
    illness_cleared: true,
    equipment_ready: true,
    environment_clear: true,
  });
  assert.equal(ready.current_state, "plan_briefing");
  assert.match(controller.getInstructions(), /week 8 of 52/i);
  const planned = event(controller, "plan_understood");
  assert.equal(planned.current_state, "exercise_intro");
  assert.equal(planned.reason, "prescribed_warm_up_omitted");
  assert.equal(controller.snapshot().current_exercise.id, "knee_bends");
  assert.match(controller.getInstructions(), /first or second exercise/);
  assert.doesNotMatch(controller.getInstructions(), /replay/i);
});

test("optional fast path remains explicit rather than the v7 default", () => {
  const controller = createOtagoController({ prescription: { ...DEMO_PRESCRIPTION, fast_demo_skip_opening_checks: true } });
  const result = event(controller, "greeting_ready");
  assert.equal(result.current_state, "exercise_intro");
  assert.equal(result.reason, "fast_demo_opening_complete");
});

test("two-action program completes the full session through review and wrap-up", () => {
  const controller = createOtagoController();
  reachActiveSet(controller);
  motion(controller, "knee_bends", 5);
  assert.equal(event(controller, "set_completed", { count: 5 }).current_state, "rest");
  assert.equal(event(controller, "rest_complete").current_state, "exercise_intro");
  assert.equal(event(controller, "prepare_exercise").current_state, "set_readiness");
  assert.equal(event(controller, "set_readiness_result", { status: "ready", evidence: ["vision"] }).current_state, "active_set");
  motion(controller, "one_leg_stand", 1);
  assert.equal(event(controller, "set_completed", { count: 1 }).reason, "side_switch");
  motion(controller, "one_leg_stand", 1);
  assert.equal(event(controller, "set_completed", { count: 1 }).current_state, "rest");
  assert.equal(event(controller, "rest_complete").current_state, "session_review_and_log");
  const finalized = controller.execute("finalize_session", { perceived_difficulty: "appropriate", issues_for_pt: [], diary_note: "", disposition: "none" });
  assert.equal(finalized.current_state, "completed");
  assert.equal(finalized.finalized, true);
});

test("ordinary prescriptions still cannot omit warm-up", () => {
  assert.throws(() => createOtagoController({
    prescription: { ...DEMO_PRESCRIPTION, demo_only: false, allow_warm_up_omission_for_technical_demo: false },
  }), /requires a warm-up queue/);
});

test("knee-bend motion results drive the authoritative five-repetition count", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  for (let index = 1; index <= 5; index += 1) {
    const result = motion(controller, "knee_bends");
    assert.equal(result.motion_progress.observed_count, index);
  }
  assert.equal(controller.snapshot().observed_count, 5);
  assert.equal(event(controller, "set_completed", { count: 5 }).current_state, "rest");
});

test("motion interface rejects results for an action other than the current cursor", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const result = motion(controller, "one_leg_stand");
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match current exercise knee_bends/);
});

test("one-leg left/right holds switch directly without another rest or readiness state", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  motion(controller, "knee_bends", 5);
  event(controller, "set_completed", { count: 5 });
  assert.equal(event(controller, "rest_complete").current_state, "exercise_intro");
  event(controller, "prepare_exercise");
  event(controller, "set_readiness_result", { status: "ready", evidence: ["vision", "user_report"] });

  const hold = motion(controller, "one_leg_stand", 1);
  assert.equal(hold.motion_progress.target_reached, true);
  const switched = event(controller, "set_completed", { count: 1 });
  assert.equal(switched.current_state, "active_set");
  assert.equal(switched.reason, "side_switch");
  assert.equal(controller.snapshot().current_set.set_id, "right-foot-lifted");
});

test("dynamic correction remains inside active_set and does not increment count", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const result = motion(controller, "knee_bends", 0, "needs_correction");
  assert.equal(result.current_state, "active_set");
  assert.equal(result.motion_progress.observed_count, 0);
  assert.equal(result.speak, true);
});

test("intermediate motion updates controller awareness without incrementing the set", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const result = intermediateMotion(controller, "rep_started");
  assert.equal(result.current_state, "active_set");
  assert.equal(result.motion_progress.observed_count, 0);
  assert.equal(result.continue_response, false);
  assert.equal(result.sync_model_state, false);
  assert.equal(controller.snapshot().motion_awareness.activity, "repetition_in_progress");
});

test("repeated invalid attempts escalate from a concise cue to vision", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const first = motion(controller, "knee_bends", 0, "needs_correction");
  const second = motion(controller, "knee_bends", 0, "needs_correction");
  assert.equal(first.attention.mode, "coach_cue");
  assert.equal(second.attention.mode, "vision");
  assert.equal(controller.snapshot().motion_awareness.consecutive_errors, 2);
});

test("uncertain activity requests visual clarification before verbal confirmation", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const first = motion(controller, "knee_bends", 0, "uncertain");
  const second = motion(controller, "knee_bends", 0, "uncertain");
  assert.equal(first.attention.mode, "vision");
  assert.equal(second.attention.mode, "voice_check");
});

test("unknown exercise motion requests a camera check before one verbal question", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const result = controller.recordMotionEvent({
    exercise: { id: "knee_bends", name: "Knee bends" },
    observation: {
      phase: "activity_hypothesis", confidence: 0.8, valid_count_increment: 0,
      metrics: { activity_supervisor: {
        activity: "unknown_exercise", behavior_pattern: "unexplained_repetitive_motion",
        confidence: 0.8, hypotheses: [{ label: "wrong_exercise", confidence: 0.58 }], features: {},
      } },
    },
    assessment: { status: "uncertain", summary: "The prescribed action does not explain the sustained motion." },
  });
  assert.equal(result.attention.mode, "vision");
  assert.equal(result.attention.purpose, "motion_uncertainty");
  assert.equal(controller.snapshot().motion_awareness.open_world_observation.activity, "unknown_exercise");
  assert.equal(controller.snapshot().motion_awareness.counting_enabled, false);
});

test("open-world hypothesis freezes counting until new temporal action evidence", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const hypothesis = controller.recordMotionEvent({
    exercise: { id: "knee_bends", name: "Knee bends" },
    observation: {
      phase: "activity_hypothesis", valid_count_increment: 0, confidence: 0.83,
      metrics: { activity_supervisor: {
        activity: "unexpected_locomotion", confidence: 0.83, unexplained_seconds: 7.4,
        candidate_persistence_seconds: 1.4, recommended_clarification: "vision_check_full_body_and_location",
        hypotheses: [{ label: "left_exercise_position", confidence: 0.52 }],
        features: { root_displacement_leg_ratio: 0.61 },
      } },
    },
    assessment: { status: "uncertain", issues: [{ code: "activity_hypothesis", severity: "moderate", summary: "Unexpected locomotion." }] },
  });
  assert.equal(hypothesis.attention.mode, "vision");
  assert.equal(controller.snapshot().motion_awareness.activity, "unexpected_locomotion");
  assert.equal(controller.snapshot().motion_awareness.counting_enabled, false);
  assert.equal(motion(controller, "knee_bends").motion_progress.observed_count, 0);

  controller.execute("submit_visual_observation", {
    activity: "performing_expected_exercise", confidence: 0.9, person_visible: true,
    full_body_visible: true, expected_exercise_visible: true, safety_concern_visible: false,
    evidence: ["Participant is back in the knee-bend starting position."],
  });
  assert.equal(controller.snapshot().motion_awareness.counting_enabled, false);
  assert.equal(controller.snapshot().motion_awareness.awaiting_confirmation, "expected_action_start");
  assert.equal(controller.snapshot().motion_awareness.vision_escalated, true);
  intermediateMotion(controller, "rep_started");
  assert.equal(controller.snapshot().motion_awareness.counting_enabled, true);
  assert.equal(motion(controller, "knee_bends").motion_progress.observed_count, 1);
});

test("persistent open-world activity escalates from one image to one intent question", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const observation = {
    exercise: { id: "knee_bends", name: "Knee bends" },
    observation: { phase: "activity_hypothesis", confidence: 0.8, valid_count_increment: 0, metrics: { activity_supervisor: {
      activity: "inactive_present", confidence: 0.8, unexplained_seconds: 8,
      candidate_persistence_seconds: 2, hypotheses: [{ label: "resting", confidence: 0.5 }], features: {},
    } } },
    assessment: { status: "uncertain", summary: "Expected activity remains absent." },
  };
  assert.equal(controller.recordMotionEvent(observation).attention.mode, "vision");
  assert.equal(controller.recordMotionEvent(observation).attention.mode, "voice_check");
});

test("low-confidence vision cannot reopen motion counting", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  controller.recordMotionEvent({
    exercise: { id: "knee_bends" },
    observation: { phase: "activity_hypothesis", confidence: 0.75, metrics: { activity_supervisor: {
      activity: "inactive_present", confidence: 0.75, hypotheses: [], features: {}, unexplained_seconds: 8,
    } } },
    assessment: { status: "uncertain", summary: "No expected action was recognized." },
  });
  const visual = controller.execute("submit_visual_observation", {
    activity: "performing_expected_exercise", confidence: 0.42, person_visible: true,
    full_body_visible: false, expected_exercise_visible: true, safety_concern_visible: false,
    evidence: ["Only part of the body is visible."],
  });
  assert.equal(visual.attention.mode, "voice_check");
  assert.equal(controller.snapshot().motion_awareness.counting_enabled, false);
});

test("possible fall freezes counting until an explicit safety clarification", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const hypothesis = controller.recordMotionEvent({
    exercise: { id: "knee_bends", name: "Knee bends" },
    observation: { phase: "possible_fall", valid_count_increment: 0, confidence: 0.9 },
    assessment: { status: "uncertain", issues: [{ code: "possible_fall", severity: "critical", summary: "Rapid pelvis descent and trunk lean." }] },
  });
  assert.equal(hypothesis.attention.mode, "safety_check");
  assert.equal(hypothesis.pause_motion, true);
  assert.equal(controller.snapshot().motion_awareness.supervisory_pause, true);

  const ignored = motion(controller, "knee_bends", 1, "correct");
  assert.equal(ignored.motion_progress, undefined);
  assert.equal(controller.snapshot().observed_count, 0);

  const resumed = event(controller, "perception_check_result", { status: "safe_to_continue", evidence: ["user_report"] });
  assert.equal(resumed.resume_motion, true);
  assert.equal(controller.snapshot().motion_awareness.supervisory_pause, false);
  assert.equal(motion(controller, "knee_bends").motion_progress.observed_count, 1);
});

test("confirmed possible fall enters the deterministic safety stop", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  controller.recordMotionEvent({
    exercise: { id: "knee_bends" },
    observation: { phase: "possible_fall", valid_count_increment: 0, confidence: 0.9 },
    assessment: { status: "uncertain", issues: [{ code: "possible_fall", severity: "critical", summary: "Possible fall." }] },
  });
  const stopped = event(controller, "perception_check_result", { status: "confirmed_safety_concern", evidence: ["user_report"] });
  assert.equal(stopped.current_state, "stop_session");
});

test("a valid attempt after correction closes the feedback loop", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  motion(controller, "knee_bends", 0, "needs_correction");
  const improved = motion(controller, "knee_bends", 1, "correct");
  assert.equal(improved.attention.mode, "recovery_ack");
  assert.equal(controller.snapshot().motion_awareness.last_correction_outcome, "improved_on_next_valid_attempt");
  assert.equal(controller.snapshot().motion_awareness.pending_correction, null);
});

test("tool surface stays compact and current instructions contain only knee bends", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  assert.deepEqual(controller.getTools().map((tool) => tool.name), ["submit_session_event", "capture_vision_snapshot", "report_safety_stop", "get_current_progress", "submit_visual_observation"]);
  const prompt = controller.getInstructions();
  assert.ok(prompt.length < 8000);
  assert.match(prompt, /knee_bends/);
  assert.doesNotMatch(prompt, /heel_toe_walking/);
});

test("progress queries return the authoritative repetition count", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  motion(controller, "knee_bends");
  motion(controller, "knee_bends");

  const result = controller.execute("get_current_progress");
  assert.equal(result.continue_response, false);
  assert.deepEqual(result.progress_query, {
    exercise_id: "knee_bends",
    exercise_name: "Knee bends",
    set_id: "demo-five-reps",
    side: "bilateral",
    unit: "repetitions",
    observed_count: 2,
    target_count: 5,
    remaining_count: 3,
    elapsed_seconds: null,
    target_seconds: null,
    remaining_seconds: null,
    counting_enabled: true,
    supervisory_pause: false,
  });
});

test("a wall-clock stream stall freezes count until fresh action evidence", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  motion(controller, "knee_bends");
  const stalled = controller.recordMotionEvent({
    exercise: { id: "knee_bends", name: "Knee bends" },
    observation: { phase: "stream_stalled", valid_count_increment: 0, confidence: 0.98, metrics: { silence_seconds: 2.5 } },
    assessment: { status: "uncertain", summary: "No motion frames arrived.", issues: [{ code: "no_motion_frames", severity: "high", summary: "No motion frames arrived." }] },
  });
  assert.equal(stalled.attention.mode, "vision");
  assert.equal(controller.snapshot().motion_awareness.activity, "stream_stalled");
  assert.equal(controller.snapshot().motion_awareness.counting_enabled, false);
  const ignored = motion(controller, "knee_bends");
  assert.equal(ignored.motion_progress.observed_count, 1);
  intermediateMotion(controller, "rep_started");
  const resumed = motion(controller, "knee_bends");
  assert.equal(resumed.motion_progress.observed_count, 2);
});

test("structured visual observation separates activity inference from intervention", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const result = controller.execute("submit_visual_observation", {
    activity: "wrong_exercise",
    confidence: 0.84,
    person_visible: true,
    full_body_visible: true,
    expected_exercise_visible: false,
    safety_concern_visible: false,
    evidence: ["Participant is moving, but no knee-bend cycle is visible."],
  });
  assert.equal(result.current_state, "active_set");
  assert.equal(result.attention.mode, "coach_cue");
  assert.equal(controller.snapshot().motion_awareness.activity, "wrong_exercise");
  assert.equal(controller.snapshot().motion_awareness.counting_enabled, false);
});

test("a new expected-action start re-enables counting after a visual activity hold", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  controller.execute("submit_visual_observation", {
    activity: "adjusting_equipment", confidence: 0.9, person_visible: true,
    full_body_visible: true, expected_exercise_visible: false, safety_concern_visible: false,
    evidence: ["Participant is repositioning the chair."],
  });
  const ignored = motion(controller, "knee_bends", 1, "correct");
  assert.equal(ignored.motion_progress.observed_count, 0);
  intermediateMotion(controller, "rep_started");
  assert.equal(controller.snapshot().motion_awareness.counting_enabled, true);
  assert.equal(motion(controller, "knee_bends", 1, "correct").motion_progress.observed_count, 1);
});

test("visual possible-fall evidence freezes counting but still requires verbal confirmation", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const result = controller.execute("submit_visual_observation", {
    activity: "possible_fall", confidence: 0.76, person_visible: true,
    full_body_visible: false, expected_exercise_visible: false, safety_concern_visible: true,
    evidence: ["Participant appears close to the floor."],
  });
  assert.equal(result.attention.mode, "safety_check");
  assert.equal(result.pause_motion, true);
  assert.equal(controller.snapshot().current_state, "active_set");
  assert.equal(controller.snapshot().motion_awareness.supervisory_pause, true);
});

test("safety concern locks the exercise flow", () => {
  const controller = controllerWithOpeningChecks();
  reachActiveSet(controller);
  const result = controller.execute("report_safety_stop", { concern: "instability", evidence: ["motion_perception"] });
  assert.equal(result.current_state, "stop_session");
  assert.equal(event(controller, "set_completed", { count: 5 }).ok, false);
});
