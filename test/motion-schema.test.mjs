import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMotionEvent, validateMotionEvent } from "../public/motion-schema.js";

test("normalizes a compact collaborator event", () => {
  const event = normalizeMotionEvent({
    exercise_id: "sit_to_stand",
    rep_index: 4,
    status: "needs_correction",
    confidence: 1.4,
    issue_code: "uses_hands",
    severity: "low",
    message: "Hands were used despite the prescribed no-hand variant.",
  });

  assert.equal(event.exercise.id, "sit_to_stand");
  assert.equal(event.exercise.rep_index, 4);
  assert.equal(event.assessment.status, "needs_correction");
  assert.equal(event.assessment.requires_response, true);
  assert.equal(event.assessment.issues[0].code, "uses_hands");
  assert.equal(event.assessment.issues[0].confidence, 1);
  assert.deepEqual(validateMotionEvent(event), []);
});

test("correct observations stay silent by default", () => {
  const event = normalizeMotionEvent({ exercise_id: "knee_bend", phase: "rep_completed", status: "correct" });
  assert.equal(event.assessment.requires_response, false);
  assert.equal(event.observation.valid_count_increment, 1);
});

test("motion count increment is explicit and uncertainty does not advance by default", () => {
  const batch = normalizeMotionEvent({ exercise_id: "heel_toe_walking", phase: "set_completed", status: "correct", valid_count_increment: 10 });
  assert.equal(batch.observation.valid_count_increment, 10);
  const uncertain = normalizeMotionEvent({ exercise_id: "heel_toe_walking", phase: "step_completed", status: "uncertain" });
  assert.equal(uncertain.observation.valid_count_increment, 0);
});

test("unknown status becomes uncertain", () => {
  const event = normalizeMotionEvent({ exercise_id: "hip_abduction", status: "maybe" });
  assert.equal(event.assessment.status, "uncertain");
  assert.equal(event.assessment.requires_response, true);
});

test("perception boundary removes prerecorded-input provenance", () => {
  const event = normalizeMotionEvent({
    exercise_id: "knee_bends",
    status: "uncertain",
    clip_id: "raw-output1-secret",
    metrics: {
      source_frame: 42,
      source_time_s: 1.4,
      recorded_source_time_s: 21.4,
      replay_source: { source_label: "recorded clip", source_action_id: "other_action" },
    },
  });
  assert.equal("clip_id" in event.observation, false);
  assert.equal(event.observation.metrics.source_frame, 42);
  assert.equal(event.observation.metrics.source_time_s, 1.4);
  assert.equal("recorded_source_time_s" in event.observation.metrics, false);
  assert.equal("replay_source" in event.observation.metrics, false);
});
