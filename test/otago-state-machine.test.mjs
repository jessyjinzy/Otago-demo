import test from "node:test";
import assert from "node:assert/strict";
import { createOtagoStateMachine, DEMO_PRESCRIPTION } from "../otago-state-machine.mjs";
import { getSystemInstruction } from "../instruction-library.mjs";

function advanceToActiveSet(coach) {
  assert.equal(coach.execute("complete_greeting", { ready_for_check: true }).current_state, "readiness_check");
  assert.equal(coach.execute("record_readiness", {
    no_warning_symptoms: true, illness_cleared: true, equipment_ready: true, environment_clear: true, concern: "none",
  }).current_state, "plan_briefing");
  assert.equal(coach.execute("confirm_plan_briefing", { understood: true }).current_state, "warm_up_sequence");
  while (coach.snapshot().current_state === "warm_up_sequence") coach.execute("record_warm_up_item", { outcome: "completed" });
  assert.equal(coach.snapshot().current_state, "exercise_intro");
  assert.equal(coach.execute("begin_form_check", { ready: true }).current_state, "form_check");
  assert.equal(coach.execute("record_form_check", { outcome: "ready", issue: "", evidence: ["prescription", "motion"] }).current_state, "active_set");
}

test("exposes only state-scoped functions", () => {
  const coach = createOtagoStateMachine();
  assert.deepEqual(coach.getTools().map((entry) => entry.name), ["complete_greeting", "capture_vision_snapshot"]);
  assert.equal(coach.execute("record_readiness", {}).ok, false);
});

test("makes one non-transitioning vision tool available throughout active interaction", () => {
  const coach = createOtagoStateMachine();
  const request = coach.execute("capture_vision_snapshot", {
    purpose: "framing_check",
    focus: "Confirm the participant's full body and chair are visible.",
    reason: "Avoid asking for a verbal description of framing.",
  });
  assert.equal(request.ok, true);
  assert.equal(request.current_state, "greeting");
  assert.equal(request.state_changed, false);
  assert.equal(request.continue_response, false);
  assert.equal(request.capture_vision, true);
  assert.equal(request.vision_request.purpose, "framing_check");

  coach.execute("complete_greeting", { ready_for_check: true });
  assert.ok(coach.getTools().some((entry) => entry.name === "capture_vision_snapshot"));
});

test("follows greeting, readiness, plan, warm-up, introduction, form check, and active set", () => {
  const coach = createOtagoStateMachine();
  advanceToActiveSet(coach);
  assert.equal(coach.snapshot().current_exercise.id, "front_knee_strengthening");
  assert.equal(coach.snapshot().current_set.side, "left");
});

test("unsafe readiness jumps to stop_session", () => {
  const coach = createOtagoStateMachine();
  coach.execute("complete_greeting", { ready_for_check: true });
  const result = coach.execute("record_readiness", {
    no_warning_symptoms: false, illness_cleared: true, equipment_ready: true, environment_clear: true, concern: "dizziness",
  });
  assert.equal(result.current_state, "stop_session");
  assert.deepEqual(coach.getTools().map((entry) => entry.name), ["complete_stop_session", "capture_vision_snapshot"]);
});

test("correct motion is silent while correction returns to form check", () => {
  const coach = createOtagoStateMachine();
  advanceToActiveSet(coach);
  const valid = coach.execute("record_motion_assessment", { result: "valid", observed_count_increment: 1, issue: "", confidence: 0.96 });
  assert.equal(valid.current_state, "active_set");
  assert.equal(valid.continue_response, false);
  const correction = coach.execute("record_motion_assessment", { result: "valid_with_correction", observed_count_increment: 0, issue: "trunk lean", confidence: 0.88 });
  assert.equal(correction.current_state, "form_check");
});

test("participant can skip an exercise from setup or active-set state", () => {
  const coach = createOtagoStateMachine();
  advanceToActiveSet(coach);
  assert.ok(coach.getTools().some((tool) => tool.name === "skip_current_exercise"));
  const result = coach.execute("skip_current_exercise", { reason: "participant requested skip" });
  assert.equal(result.current_state, "exercise_intro");
  assert.equal(coach.snapshot().current_exercise.id, "side_hip_strengthening");
});

test("rest hub keeps side switch in the prescribed set sequence", () => {
  const coach = createOtagoStateMachine();
  advanceToActiveSet(coach);
  const completion = coach.execute("complete_active_set", { completed_count: 10 });
  assert.equal(coach.snapshot().current_state, "rest");
  assert.equal(completion.auto_route, "next_set");
  assert.equal(coach.execute("route_from_rest", { action: "next_set" }).current_state, "active_set");
  assert.equal(coach.snapshot().current_set.side, "right");
});

test("controller can automatically route a completed set through rest", () => {
  const coach = createOtagoStateMachine();
  advanceToActiveSet(coach);
  coach.execute("complete_active_set", { completed_count: 10 });
  const result = coach.autoRouteFromRest();
  assert.equal(result.current_state, "active_set");
  assert.equal(coach.snapshot().current_set.side, "right");
});

test("prescription is replaceable only before warm-up", () => {
  const coach = createOtagoStateMachine();
  const replacement = structuredClone(DEMO_PRESCRIPTION);
  replacement.prescription_id = "pt-plan-7";
  assert.equal(coach.setPrescription(replacement).ok, true);
  coach.execute("complete_greeting", { ready_for_check: true });
  coach.execute("record_readiness", { no_warning_symptoms: true, illness_cleared: true, equipment_ready: true, environment_clear: true, concern: "none" });
  coach.execute("confirm_plan_briefing", { understood: true });
  assert.equal(coach.setPrescription(replacement).ok, false);
});

test("completed state can explicitly start a fresh run", () => {
  const coach = createOtagoStateMachine();
  const result = coach.execute("complete_greeting", { ready_for_check: true });
  assert.equal(result.current_state, "readiness_check");
  // Reach completed through the normal terminal sequence without needing to exercise every task.
  const terminal = createOtagoStateMachine();
  terminal.execute("complete_greeting", { ready_for_check: true });
  terminal.execute("record_readiness", { no_warning_symptoms: false, illness_cleared: true, equipment_ready: true, environment_clear: true, concern: "dizziness" });
  terminal.execute("complete_stop_session", { acknowledged: true, disposition: "healthcare_follow_up" });
  terminal.execute("save_session_review", { perceived_difficulty: "not_reported", issues_for_pt: [] });
  terminal.execute("close_session", { closed: true });
  assert.equal(terminal.snapshot().current_state, "completed");
  assert.deepEqual(terminal.getTools().map((item) => item.name), ["start_new_session"]);
  assert.equal(terminal.execute("start_new_session", { requested: true }).current_state, "greeting");
  assert.equal(terminal.snapshot().run_number, 2);
});

test("communication policy adapts from detailed early practice to concise week-eight maintenance", () => {
  const earlyPlan = structuredClone(DEMO_PRESCRIPTION);
  earlyPlan.program_week = 1;
  const early = createOtagoStateMachine({ prescription: earlyPlan });
  const weekEight = createOtagoStateMachine();
  assert.equal(early.snapshot().communication_policy.phase, "early familiarization");
  assert.equal(weekEight.snapshot().communication_policy.phase, "maintenance / familiar practice");
  assert.match(weekEight.getInstructions(), /Forbidden spoken patterns/);
  assert.match(weekEight.getInstructions(), /\[STATE_ADVANCE\]/);
  assert.match(weekEight.getInstructions(), /one direct instruction of no more than about 12 spoken words/);
});

test("keeps global and state runtime prompts compact", () => {
  assert.ok(getSystemInstruction().length < 3000);
  const coach = createOtagoStateMachine();
  assert.doesNotMatch(coach.getInstructions(), /walking_plan/);
  coach.execute("complete_greeting", { ready_for_check: true });
  coach.execute("record_readiness", { no_warning_symptoms: true, illness_cleared: true, equipment_ready: true, environment_clear: true, concern: "none" });
  assert.match(coach.getInstructions(), /walking_plan/);
  coach.execute("confirm_plan_briefing", { understood: true });
  while (coach.snapshot().current_state === "warm_up_sequence") coach.execute("record_warm_up_item", { outcome: "completed" });
  coach.execute("begin_form_check", { ready: true });
  coach.execute("record_form_check", { outcome: "ready", issue: "", evidence: ["user_report"] });
  const activeSetPrompt = coach.getInstructions();
  assert.ok(activeSetPrompt.length < 10000);
  assert.doesNotMatch(activeSetPrompt, /walking_plan|clinician_only_decisions|weekly_history/);
  assert.match(activeSetPrompt, /"set":\{"set_id":"left-1"/);
});
