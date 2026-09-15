import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGvhmrDetector, GlobalMotionMonitor, GvhmrReplayEngine } from "../public/gvhmr-motion.js";
import { OpenWorldActivitySupervisor } from "../public/open-world-activity.js";

const dataset = JSON.parse(readFileSync(new URL("../public/motion-data/gvhmr-demo.json", import.meta.url), "utf8"));

function detect(actionId, setId) {
  const action = dataset.actions[actionId];
  const segment = action.segments.find((item) => item.set_id === setId);
  const detector = createGvhmrDetector(action, segment);
  return segment.frames.flatMap((frame) => detector.process(frame).events);
}

test("compact fixture keeps only the required joints and downsampled frames", () => {
  assert.equal(dataset.joint_schema, "SMPL-24");
  assert.equal(dataset.selected_joints.length, 10);
  assert.equal(dataset.actions.knee_bends.analysis_fps, 10);
  assert.equal(dataset.actions.one_leg_stand.analysis_fps, 5);
  assert.ok(JSON.stringify(dataset).length < 180_000);
});

test("knee detector extracts five valid repetitions from output1", () => {
  const allEvents = detect("knee_bends", "demo-five-reps");
  const events = allEvents.filter((event) => event.observation.phase === "rep_completed");
  assert.equal(events.length, 5);
  assert.equal(allEvents.filter((event) => event.observation.phase === "rep_started").length, 5);
  assert.ok(events.every((event) => event.assessment.status === "correct"));
  assert.deepEqual(events.map((event) => event.exercise.rep_index), [1, 2, 3, 4, 5]);
  assert.ok(events.every((event) => event.observation.metrics.minimum_knee_angle_deg < 140));
});

test("one-leg detector extracts one ten-second hold for each side from output2", () => {
  for (const setId of ["left-foot-lifted", "right-foot-lifted"]) {
    const events = detect("one_leg_stand", setId);
    const completed = events.filter((event) => event.observation.phase === "hold_completed");
    assert.equal(completed.length, 1);
    assert.ok(events.some((event) => event.observation.phase === "hold_started"));
    assert.ok(events.some((event) => event.observation.phase === "hold_progress"));
    assert.equal(completed[0].assessment.status, "correct");
    assert.equal(completed[0].observation.valid_count_increment, 1);
    assert.equal(completed[0].observation.metrics.hold_seconds, 10);
  }
});

test("one-leg hold uses source timestamps and tolerates periodic frame loss", () => {
  const action = dataset.actions.one_leg_stand;
  const segment = action.segments[0];
  const detector = createGvhmrDetector(action, segment);
  const events = segment.frames
    .filter((_, index) => index % 4 !== 0)
    .flatMap((frame) => detector.process(frame).events);
  assert.equal(events.filter((event) => event.observation.phase === "hold_completed").length, 1);
});

test("global monitor turns missing joints into a tracking uncertainty instead of crashing", () => {
  const action = dataset.actions.knee_bends;
  const segment = action.segments[0];
  const monitor = new GlobalMotionMonitor(action, segment);
  const first = monitor.inspect({ source_time_s: 0, joints: {} }, null, []);
  const second = monitor.inspect({ source_time_s: 1.1, joints: {} }, null, []);
  assert.equal(first.length, 0);
  assert.equal(second[0].observation.phase, "tracking_lost");
  assert.equal(second[0].assessment.status, "uncertain");
});

test("tracking loss recovery does not create a duplicate stream-gap alert", () => {
  const action = dataset.actions.knee_bends;
  const segment = action.segments[0];
  const monitor = new GlobalMotionMonitor(action, segment);
  const good = segment.frames[0].joints;
  const events = [];
  events.push(...monitor.inspect({ source_time_s: 0, joints: good }, { phase: "standing" }, []));
  for (let index = 1; index <= 20; index += 1) {
    events.push(...monitor.inspect({ source_time_s: index / 10, joints: {} }, null, []));
  }
  events.push(...monitor.inspect({ source_time_s: 2.1, joints: good }, { phase: "standing" }, []));
  assert.ok(events.some((event) => event.observation.phase === "tracking_lost"));
  assert.equal(events.some((event) => event.observation.phase === "stream_gap"), false);
});

test("global monitor escalates repeated dropped samples", () => {
  const action = dataset.actions.knee_bends;
  const segment = action.segments[0];
  const monitor = new GlobalMotionMonitor(action, segment);
  const events = [];
  for (let index = 0; index < 16; index += 1) {
    const source = segment.frames[Math.min(index * 2, segment.frames.length - 1)];
    events.push(...monitor.preflight({ ...source, source_time_s: index * 0.2 }).events);
  }
  assert.ok(events.some((event) => event.observation.phase === "frame_loss"));
  assert.equal(events.some((event) => event.observation.valid_count_increment > 0), false);
});

test("global monitor blocks an unexpected tracked-person switch", () => {
  const action = dataset.actions.knee_bends;
  const segment = action.segments[0];
  const monitor = new GlobalMotionMonitor(action, segment);
  const joints = segment.frames[0].joints;
  assert.equal(monitor.preflight({ source_time_s: 0, person_id: "participant-a", joints }).blocked, false);
  const switched = monitor.preflight({ source_time_s: 0.1, person_id: "participant-b", joints });
  assert.equal(switched.blocked, true);
  assert.equal(switched.events[0].observation.phase, "identity_changed");
});

test("global monitor emits ranked open-world hypotheses for unexplained inactivity", () => {
  const action = dataset.actions.knee_bends;
  const segment = action.segments[0];
  const monitor = new GlobalMotionMonitor(action, segment);
  const joints = segment.frames[0].joints;
  let events = [];
  for (let step = 0; step <= 151; step += 1) {
    events = [...events, ...monitor.inspect({ source_time_s: step / 10, joints }, { phase: "standing" }, [])];
  }
  events = events.filter((event) => event.observation.phase === "activity_hypothesis");
  assert.equal(events[0].observation.phase, "activity_hypothesis");
  assert.equal(events[0].assessment.status, "uncertain");
  assert.equal(events[0].observation.valid_count_increment, 0);
  assert.equal(events[0].observation.metrics.activity_supervisor.activity, "unknown_exercise");
  assert.equal(events[0].observation.metrics.activity_supervisor.behavior_pattern, "inactive_present");
  assert.ok(events[0].observation.metrics.activity_supervisor.hypotheses.length >= 2);
});

test("persistent unexplained activity is rechecked without firing every frame", () => {
  const base = dataset.actions.knee_bends.segments[0].frames[0].joints;
  const supervisor = new OpenWorldActivitySupervisor({ expectedActionId: "knee_bends", analysisFps: 10, recheckSeconds: 4 });
  const emittedAt = [];
  for (let step = 0; step <= 180; step += 1) {
    const result = supervisor.observe({ source_time_s: step / 10, joints: base }, { phase: "standing" }, []);
    if (result.shouldEmit) emittedAt.push(step / 10);
  }
  assert.ok(emittedAt.length >= 2);
  assert.ok(emittedAt.every((time, index) => index === 0 || time - emittedAt[index - 1] >= 3.9));
});

test("open-world supervisor distinguishes sustained locomotion from waiting", () => {
  const base = dataset.actions.knee_bends.segments[0].frames[0].joints;
  const supervisor = new OpenWorldActivitySupervisor({ expectedActionId: "knee_bends", analysisFps: 10 });
  const emitted = [];
  for (let step = 0; step <= 100; step += 1) {
    const joints = structuredClone(base);
    for (const point of Object.values(joints)) point[0] += step * 0.018;
    const result = supervisor.observe({ source_time_s: step / 10, joints }, { phase: "standing" }, []);
    if (result.shouldEmit) emitted.push(result.observation);
  }
  assert.ok(emitted.length >= 1);
  assert.equal(emitted.at(-1).activity, "unknown_exercise");
  assert.equal(emitted.at(-1).behavior_pattern, "unexpected_locomotion");
  assert.ok(emitted.at(-1).features.root_displacement_leg_ratio > 0.3);
  assert.equal(emitted.at(-1).recommended_clarification, "vision_check_full_body_and_location");
});

test("open-world supervisor identifies sustained repetitive non-locomotor motion", () => {
  const base = dataset.actions.knee_bends.segments[0].frames[0].joints;
  const supervisor = new OpenWorldActivitySupervisor({ expectedActionId: "one_leg_stand", analysisFps: 10 });
  const emitted = [];
  for (let step = 0; step <= 120; step += 1) {
    const joints = structuredClone(base);
    const offset = 0.09 * Math.sin(2 * Math.PI * (step / 10) / 1.6);
    joints.pelvis[1] += offset;
    joints.neck[1] += offset;
    const result = supervisor.observe({ source_time_s: step / 10, joints }, { phase: "standing" }, []);
    if (result.shouldEmit) emitted.push(result.observation);
  }
  assert.ok(emitted.some((item) => item.activity === "unknown_exercise" && item.behavior_pattern === "unexplained_repetitive_motion"));
  assert.ok(supervisor.lastObservation.features.vertical_turning_points >= 3);
  assert.ok(supervisor.lastObservation.features.root_displacement_leg_ratio < 0.25);
});

test("valid prerecorded actions do not trigger an open-world interruption", () => {
  for (const action of Object.values(dataset.actions)) {
    for (const segment of action.segments) {
      const detector = createGvhmrDetector(action, segment);
      const monitor = new GlobalMotionMonitor(action, segment);
      const globalEvents = [];
      for (const frame of segment.frames) {
        const actionResult = detector.process(frame);
        globalEvents.push(...monitor.inspect(frame, actionResult.telemetry, actionResult.events));
      }
      assert.equal(globalEvents.some((event) => event.observation.phase === "activity_hypothesis"), false);
      assert.equal(globalEvents.some((event) => event.observation.phase === "possible_fall"), false);
    }
  }
});

test("a detector stuck in one phase cannot hide a wrong prerecorded action", () => {
  const engine = new GvhmrReplayEngine({ dataUrl: "unused", pushEvent: async () => {} });
  engine.dataset = dataset;
  engine.registerDataset(dataset, "fixture", "fixture");
  const wrongClip = engine.listClips().find((clip) => clip.action_id === "one_leg_stand" && clip.set_id === "left-foot-lifted");
  engine.setReplayQueue([{ clip_id: wrongClip.id }]);
  const resolved = engine.resolve({
    current_state: "active_set", run_number: 1,
    current_exercise: { id: "knee_bends", name: "Knee bends" },
    current_set: { set_id: "demo-five-reps", repetitions: 5 },
  });
  const detector = createGvhmrDetector(resolved.action, resolved.segment);
  const monitor = new GlobalMotionMonitor(resolved.action, resolved.segment);
  const events = [];
  for (const frame of resolved.segment.frames) {
    const actionResult = detector.process(frame);
    events.push(...monitor.inspect(frame, actionResult.telemetry, actionResult.events));
  }
  const hypothesis = events.find((event) => event.observation.phase === "activity_hypothesis");
  assert.ok(hypothesis, "wrong-action replay should eventually require clarification");
  assert.equal(hypothesis.exercise.id, "knee_bends");
  assert.equal(hypothesis.observation.valid_count_increment, 0);
});

test("global monitor emits a conservative possible-fall safety event", () => {
  const action = dataset.actions.knee_bends;
  const segment = action.segments[0];
  const monitor = new GlobalMotionMonitor(action, segment);
  const baseline = structuredClone(segment.frames[0].joints);
  monitor.inspect({ source_time_s: 0, joints: baseline }, { phase: "standing" }, []);
  const fallen = structuredClone(baseline);
  fallen.pelvis[1] -= 1;
  fallen.neck = [fallen.pelvis[0] + 1, fallen.pelvis[1], fallen.pelvis[2]];
  const events = monitor.inspect({ source_time_s: 0.2, joints: fallen }, { phase: "unknown" }, []);
  assert.equal(events[0].observation.phase, "possible_fall");
  assert.equal(events[0].assessment.status, "uncertain");
  assert.equal(events[0].assessment.issues[0].severity, "critical");
});

test("replay pause preserves the active frame and resume continues it", () => {
  let resumed = 0;
  const engine = new GvhmrReplayEngine({ dataUrl: "unused", pushEvent: async () => {} });
  const token = Symbol("test");
  engine.active = { token, actionName: "Knee bends", frameIndex: 17, timer: setTimeout(() => {}, 10_000) };
  engine.pause();
  assert.equal(engine.paused, true);
  assert.equal(engine.active.frameIndex, 17);
  assert.equal(engine.active.timer, undefined);
  engine.tick = async (received) => { assert.equal(received, token); resumed += 1; };
  engine.resume();
  assert.equal(engine.paused, false);
  assert.equal(resumed, 1);
});

test("live adapter accepts a standard-order SMPL-24 joint frame", async () => {
  const names = ["pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2", "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot", "neck", "left_collar", "right_collar", "head", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hand", "right_hand"];
  const source = dataset.actions.knee_bends.segments[0].frames[0];
  const array = names.map((name) => source.joints[name] || [0, 0, 0]);
  let telemetry;
  const engine = new GvhmrReplayEngine({
    dataUrl: "unused",
    pushEvent: async () => {},
    onTelemetry: (value) => { telemetry = value; },
  });
  engine.dataset = dataset;
  engine.snapshot = {
    current_state: "active_set",
    run_number: 1,
    current_exercise: { id: "knee_bends", name: "Knee bends" },
    current_set: { set_id: "demo-five-reps", repetitions: 5 },
  };
  await engine.processLiveFrame({ type: "joint_frame", frame_index: 0, source_time_s: 0, fps: 10, joints3d_global: array });
  assert.equal(telemetry.detector, "knee_bends");
  assert.equal(engine.externalStreamActive, true);
});

test("replay queue can deliberately feed a different recorded action into the current detector", () => {
  const engine = new GvhmrReplayEngine({ dataUrl: "unused", pushEvent: async () => {} });
  engine.dataset = dataset;
  engine.registerDataset(dataset, "fixture", "fixture");
  const sourceClip = engine.listClips().find((clip) => clip.source_id === "fixture" && clip.action_id === "one_leg_stand");
  engine.setReplayQueue([{ clip_id: sourceClip.id, fault_preset: "none", startup_delay_ms: 750 }]);
  const resolved = engine.resolve({
    current_state: "active_set", run_number: 1,
    current_exercise: { id: "knee_bends", name: "Knee bends" },
    current_set: { set_id: "demo-five-reps", repetitions: 5 },
  });
  assert.equal(resolved.action.detector.type, "knee_bends");
  assert.equal(resolved.action.id, "knee_bends");
  assert.equal(resolved.replaySource.source_action_id, "one_leg_stand");
  assert.equal(resolved.startupDelayMs, 750);
});

test("replay queue applies an occlusion preset without mutating the source fixture", () => {
  const engine = new GvhmrReplayEngine({ dataUrl: "unused", pushEvent: async () => {} });
  engine.dataset = dataset;
  engine.registerDataset(dataset, "fixture", "fixture");
  const sourceClip = engine.listClips().find((clip) => clip.source_id === "fixture" && clip.action_id === "knee_bends");
  engine.setReplayQueue([{ clip_id: sourceClip.id, fault_preset: "lower_body_occlusion" }]);
  const resolved = engine.resolve({
    current_state: "active_set", run_number: 1,
    current_exercise: { id: "knee_bends", name: "Knee bends" },
    current_set: { set_id: "demo-five-reps", repetitions: 5 },
  });
  assert.ok(resolved.segment.frames.some((frame) => !frame.joints.left_knee));
  assert.ok(dataset.actions.knee_bends.segments[0].frames.every((frame) => frame.joints.left_knee));
});

test("a selected clip can replace the default before active replay begins", () => {
  const engine = new GvhmrReplayEngine({ dataUrl: "unused", pushEvent: async () => {} });
  engine.dataset = dataset;
  engine.registerDataset(dataset, "fixture", "fixture");
  const sourceClip = engine.listClips().find((clip) => clip.source_id === "fixture" && clip.action_id === "one_leg_stand");
  const staged = engine.replaceCurrentOrNext({ clip_id: sourceClip.id }, { current_state: "exercise_intro" });
  assert.equal(staged.mode, "staged_for_next_active_set");
  const resolved = engine.resolve({
    current_state: "active_set", run_number: 1,
    current_exercise: { id: "knee_bends", name: "Knee bends" },
    current_set: { set_id: "demo-five-reps", repetitions: 5 },
  });
  assert.equal(resolved.replaySource.source_action_id, "one_leg_stand");
});

test("an in-progress source switch changes only future frames and retains detector history", () => {
  const engine = new GvhmrReplayEngine({ dataUrl: "unused", pushEvent: async () => {} });
  engine.dataset = dataset;
  engine.registerDataset(dataset, "fixture", "fixture");
  const snapshot = {
    current_state: "active_set", run_number: 1, observed_count: 2,
    current_exercise: { id: "knee_bends", name: "Knee bends" },
    current_set: { set_id: "demo-five-reps", repetitions: 5 },
  };
  const sourceClip = engine.listClips().find((clip) => clip.source_id === "fixture" && clip.action_id === "one_leg_stand");
  const sourceSegment = dataset.actions.one_leg_stand.segments.find((segment) => segment.segment_id === sourceClip.segment_id);
  const initial = engine.resolve(snapshot);
  const detector = createGvhmrDetector(initial.action, initial.segment);
  const globalMonitor = new GlobalMotionMonitor(initial.action, initial.segment);
  const token = Symbol("continuous-stream");
  engine.active = { ...initial, token, detector, globalMonitor, frameIndex: 12, streamAnalysisFps: initial.action.analysis_fps };
  engine.paused = true;
  const previousFrame = initial.segment.frames[11];
  const result = engine.replaceCurrentOrNext({ clip_id: sourceClip.id }, snapshot);
  assert.equal(result.mode, "replaced_current_paused");
  assert.equal(engine.active.detector, detector);
  assert.equal(engine.active.globalMonitor, globalMonitor);
  assert.equal(engine.active.replaySource.source_action_id, "one_leg_stand");
  assert.equal(engine.active.frameIndex, 0);
  assert.ok(engine.active.segment.frames[0].source_time_s > previousFrame.source_time_s);
  assert.equal(engine.active.segment.frames[0].input_source_time_s, sourceSegment.frames[0].source_time_s);
  assert.equal(engine.snapshot, snapshot);
  engine.stop();
});

test("entering an active set prepares input but never starts it automatically", () => {
  const engine = new GvhmrReplayEngine({ dataUrl: "unused", pushEvent: async () => {} });
  engine.dataset = dataset;
  engine.registerDataset(dataset, "fixture", "fixture");
  const snapshot = {
    current_state: "active_set", run_number: 1, observed_count: 0,
    current_exercise: { id: "knee_bends", name: "Knee bends" },
    current_set: { set_id: "demo-five-reps", repetitions: 5 },
  };
  const sourceClip = engine.listClips().find((clip) => clip.source_id === "fixture" && clip.action_id === "one_leg_stand");
  let starts = 0;
  engine.start = async () => { starts += 1; };
  const result = engine.replaceCurrentOrNext({ clip_id: sourceClip.id }, snapshot, { deferStart: true });
  assert.equal(result.mode, "replaced_pending");
  assert.equal(starts, 0);
  engine.sync(snapshot);
  assert.equal(starts, 0);
  engine.replayCurrent();
  assert.equal(starts, 1);
});

test("wall-clock watchdog reports a stream that supplies no frames", async () => {
  const events = [];
  const engine = new GvhmrReplayEngine({
    dataUrl: "unused",
    pushEvent: async (event) => { events.push(event); },
    watchdogThresholdMs: 15,
  });
  engine.dataset = dataset;
  const snapshot = {
    current_state: "active_set", run_number: 1,
    current_exercise: { id: "knee_bends", name: "Knee bends" },
    current_set: { set_id: "demo-five-reps", repetitions: 5 },
  };
  const resolved = { ...engine.resolve(snapshot), startupDelayMs: 100 };
  await engine.start(resolved);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.length, 1);
  assert.equal(events[0].observation.phase, "stream_stalled");
  assert.equal(events[0].observation.valid_count_increment, 0);
  assert.equal(events[0].assessment.issues[0].code, "no_motion_frames");
  engine.stop();
});

test("watchdog is suspended while replay is intentionally paused", async () => {
  const events = [];
  const engine = new GvhmrReplayEngine({ dataUrl: "unused", pushEvent: async (event) => { events.push(event); }, watchdogThresholdMs: 15 });
  engine.active = { key: "1:knee_bends:demo-five-reps", actionName: "Knee bends", frameIndex: 0 };
  engine.armStreamWatchdog(engine.active);
  engine.pause();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.length, 0);
  engine.stop();
});
