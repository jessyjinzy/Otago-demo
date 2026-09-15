const EPSILON = 1e-8;

/**
 * Exercise-agnostic temporal supervisor for motion the prescribed detector
 * cannot explain. It proposes broad, inspectable hypotheses; it never turns a
 * hypothesis into a repetition or a clinical/safety conclusion.
 */
export class OpenWorldActivitySupervisor {
  constructor({ expectedActionId, analysisFps = 5, windowSeconds = 4, ambiguitySeconds = 6, persistenceSeconds = 1.2, recheckSeconds = 8 } = {}) {
    this.expectedActionId = expectedActionId || "current_exercise";
    this.analysisFps = Math.max(1, Number(analysisFps) || 5);
    this.windowSeconds = Math.max(2, Number(windowSeconds) || 4);
    this.ambiguitySeconds = Math.max(2, Number(ambiguitySeconds) || 6);
    this.persistenceSeconds = Math.max(0.4, Number(persistenceSeconds) || 1.2);
    this.recheckSeconds = Math.max(3, Number(recheckSeconds) || 8);
    this.samples = [];
    this.lastRecognizedTime = undefined;
    this.lastObservation = initialObservation(this.expectedActionId);
    this.emittedClass = null;
    this.emittedAt = undefined;
    this.candidateClass = null;
    this.candidateSince = undefined;
  }

  observe(frame, telemetry = {}, actionEvents = []) {
    const time = Number(frame?.source_time_s || 0);
    const joints = frame?.joints || {};
    const scale = meanLegLength(joints);
    // A detector phase may get stuck (for example, a different action can cross
    // the knee-bend start threshold and never return). Only discrete temporal
    // milestones refresh evidence that the prescribed action is progressing.
    const recognized = actionEvents.some(isPrescribedActionEvidence);
    if (this.lastRecognizedTime === undefined) this.lastRecognizedTime = time;
    if (recognized) {
      this.lastRecognizedTime = time;
      this.emittedClass = null;
      this.emittedAt = undefined;
      this.candidateClass = null;
      this.candidateSince = undefined;
    }

    this.samples.push(sampleFromFrame(time, scale, joints));
    const cutoff = time - this.windowSeconds;
    while (this.samples.length > 2 && this.samples[0].time < cutoff) this.samples.shift();

    const features = windowFeatures(this.samples);
    const unexplainedSeconds = Math.max(0, time - this.lastRecognizedTime);
    const classification = classify({ recognized, unexplainedSeconds, features });
    if (classification.activity !== this.candidateClass) {
      this.candidateClass = classification.activity;
      this.candidateSince = time;
    }
    const candidateSeconds = Math.max(0, time - (this.candidateSince ?? time));
    this.lastObservation = {
      expected_action: this.expectedActionId,
      activity: classification.activity,
      behavior_pattern: classification.behavior_pattern,
      confidence: classification.confidence,
      hypotheses: classification.hypotheses,
      unexplained_seconds: round(unexplainedSeconds, 1),
      candidate_persistence_seconds: round(candidateSeconds, 1),
      recommended_clarification: classification.recommendedClarification,
      features,
      evidence_sources: ["smpl24_window"],
    };

    const recheckDue = classification.activity !== this.emittedClass
      || this.emittedAt === undefined
      || time - this.emittedAt >= this.recheckSeconds;
    const shouldEmit = !recognized
      && unexplainedSeconds >= this.ambiguitySeconds
      && candidateSeconds >= this.persistenceSeconds
      && recheckDue;
    if (shouldEmit) {
      this.emittedClass = classification.activity;
      this.emittedAt = time;
    }
    return { observation: this.lastObservation, shouldEmit };
  }
}

function classify({ recognized, unexplainedSeconds, features }) {
  if (recognized) return result("performing_expected_exercise", 0.94,
    [["performing_expected_exercise", 0.94], ["unknown", 0.06]], "none");
  if (unexplainedSeconds < 2) return result("preparing_to_start", 0.72,
    [["preparing_to_start", 0.72], ["resting", 0.28]], "wait_for_temporal_evidence");

  const locomotion = features.root_displacement_leg_ratio >= 0.32
    || (features.root_displacement_leg_ratio >= 0.18 && features.maximum_foot_displacement_leg_ratio >= 0.42);
  if (locomotion) return result("unknown_exercise", 0.83,
    [["left_exercise_position", 0.52], ["wrong_exercise", 0.3], ["adjusting_equipment", 0.18]],
    "vision_check_full_body_and_location", "unexpected_locomotion");

  const unstable = features.maximum_trunk_lean_deg >= 42
    && (features.peak_foot_speed_leg_ratio_s >= 0.9 || features.motion_irregularity >= 0.9);
  if (unstable) return result("unstable_recovery", 0.81,
    [["unstable_recovery", 0.58], ["wrong_exercise", 0.24], ["adjusting_equipment", 0.18]],
    "freeze_and_check_visible_stability");

  const lowPelvis = features.median_pelvis_height_above_ankles_leg_ratio > 0
    && features.median_pelvis_height_above_ankles_leg_ratio < 0.52;
  if (lowPelvis && features.movement_energy < 0.12) return result("unexpected_sitting", 0.79,
    [["unexpected_sitting", 0.55], ["resting", 0.3], ["possible_fall", 0.15]],
    "vision_check_posture_then_ask_if_resting");

  const repetitive = features.vertical_turning_points >= 3
    || features.maximum_knee_flexion_range_deg >= 24;
  if (repetitive && features.root_displacement_leg_ratio < 0.25) return result("unknown_exercise", 0.8,
    [["wrong_exercise", 0.58], ["adjusting_equipment", 0.24], ["unstable_recovery", 0.18]],
    "vision_check_expected_action_and_support", "unexplained_repetitive_motion");

  if (features.movement_energy >= 0.075) return result("unknown_exercise", 0.74,
    [["adjusting_equipment", 0.38], ["wrong_exercise", 0.37], ["unstable_recovery", 0.25]],
    "vision_check_activity_and_framing", "unexplained_movement");

  return result("unknown_exercise", 0.76,
    [["resting", 0.42], ["preparing_to_start", 0.36], ["inactive_but_present", 0.22]],
    "vision_check_presence_then_one_resume_question", "inactive_present");
}

function result(activity, confidence, hypotheses, recommendedClarification, behaviorPattern = activity) {
  return {
    activity,
    behavior_pattern: behaviorPattern,
    confidence,
    hypotheses: hypotheses.map(([label, value]) => ({ label, confidence: value })),
    recommendedClarification,
  };
}

function sampleFromFrame(time, scale, joints) {
  return {
    time,
    scale,
    pelvis: point(joints.pelvis),
    neck: point(joints.neck),
    leftHip: point(joints.left_hip),
    rightHip: point(joints.right_hip),
    leftKnee: point(joints.left_knee),
    rightKnee: point(joints.right_knee),
    leftAnkle: point(joints.left_ankle),
    rightAnkle: point(joints.right_ankle),
  };
}

function windowFeatures(samples) {
  const empty = {
    window_seconds: 0,
    movement_energy: 0,
    motion_irregularity: 0,
    root_path_leg_ratio: 0,
    root_displacement_leg_ratio: 0,
    maximum_foot_displacement_leg_ratio: 0,
    foot_path_leg_ratio: 0,
    peak_foot_speed_leg_ratio_s: 0,
    pelvis_vertical_range_leg_ratio: 0,
    median_pelvis_height_above_ankles_leg_ratio: 0,
    maximum_knee_flexion_range_deg: 0,
    vertical_turning_points: 0,
    trunk_lean_deg: 0,
    maximum_trunk_lean_deg: 0,
    trunk_lean_variation_deg: 0,
  };
  if (samples.length < 2) return empty;

  const first = samples[0];
  const last = samples.at(-1);
  const scale = Math.max(EPSILON, median(samples.map((sample) => sample.scale).filter(Number.isFinite)) || 1);
  const duration = Math.max(EPSILON, last.time - first.time);
  const pelvisStepSpeeds = [];
  const footStepSpeeds = [];
  let pelvisPath = 0;
  let footPath = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const dt = Math.max(EPSILON, current.time - previous.time);
    const pelvisStep = distance(previous.pelvis, current.pelvis) / scale;
    const leftStep = distance(previous.leftAnkle, current.leftAnkle) / scale;
    const rightStep = distance(previous.rightAnkle, current.rightAnkle) / scale;
    pelvisPath += pelvisStep;
    footPath += Math.max(leftStep, rightStep);
    pelvisStepSpeeds.push(pelvisStep / dt);
    footStepSpeeds.push(Math.max(leftStep, rightStep) / dt);
  }
  const pelvisHeights = samples.map((sample) => sample.pelvis[1]);
  const pelvisAboveAnkles = samples.map((sample) =>
    (sample.pelvis[1] - (sample.leftAnkle[1] + sample.rightAnkle[1]) / 2) / scale);
  const leftKnees = samples.map((sample) => angleDegrees(sample.leftHip, sample.leftKnee, sample.leftAnkle));
  const rightKnees = samples.map((sample) => angleDegrees(sample.rightHip, sample.rightKnee, sample.rightAnkle));
  const leans = samples.map((sample) => trunkLean(sample.pelvis, sample.neck));
  const velocitiesY = samples.slice(1).map((sample, index) => {
    const previous = samples[index];
    return (sample.pelvis[1] - previous.pelvis[1]) / Math.max(EPSILON, sample.time - previous.time);
  });

  return {
    window_seconds: round(duration, 1),
    movement_energy: round(pelvisPath / duration, 3),
    motion_irregularity: round(coefficientOfVariation(pelvisStepSpeeds), 3),
    root_path_leg_ratio: round(pelvisPath, 3),
    root_displacement_leg_ratio: round(horizontalDistance(first.pelvis, last.pelvis) / scale, 3),
    maximum_foot_displacement_leg_ratio: round(Math.max(
      horizontalDistance(first.leftAnkle, last.leftAnkle),
      horizontalDistance(first.rightAnkle, last.rightAnkle),
    ) / scale, 3),
    foot_path_leg_ratio: round(footPath, 3),
    peak_foot_speed_leg_ratio_s: round(Math.max(0, ...footStepSpeeds), 3),
    pelvis_vertical_range_leg_ratio: round(range(pelvisHeights) / scale, 3),
    median_pelvis_height_above_ankles_leg_ratio: round(median(pelvisAboveAnkles), 3),
    maximum_knee_flexion_range_deg: round(Math.max(range(leftKnees), range(rightKnees)), 1),
    vertical_turning_points: directionChanges(velocitiesY, 0.015),
    trunk_lean_deg: round(leans.at(-1), 1),
    maximum_trunk_lean_deg: round(Math.max(...leans), 1),
    trunk_lean_variation_deg: round(range(leans), 1),
  };
}

function initialObservation(expectedActionId) {
  return {
    expected_action: expectedActionId,
    activity: "waiting_for_motion",
    confidence: 0,
    hypotheses: [],
    unexplained_seconds: 0,
    candidate_persistence_seconds: 0,
    recommended_clarification: "wait_for_motion",
    features: {},
    evidence_sources: [],
  };
}

function isPrescribedActionEvidence(event) {
  const phase = String(event?.observation?.phase || event?.phase || "");
  return ["rep_started", "rep_progress", "rep_completed", "hold_started", "hold_progress", "hold_completed", "hold_interrupted"].includes(phase);
}

function meanLegLength(joints) {
  const lengths = ["left", "right"].map((side) =>
    distance(point(joints[`${side}_hip`]), point(joints[`${side}_knee`]))
      + distance(point(joints[`${side}_knee`]), point(joints[`${side}_ankle`])),
  ).filter((value) => value > EPSILON);
  return lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 1;
}

function point(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)
    ? value.slice(0, 3)
    : [0, 0, 0];
}
function distance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function horizontalDistance(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]); }
function angleDegrees(a, b, c) {
  const first = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const second = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const denominator = Math.max(EPSILON, Math.hypot(...first) * Math.hypot(...second));
  const cosine = (first[0] * second[0] + first[1] * second[1] + first[2] * second[2]) / denominator;
  return Math.acos(Math.min(1, Math.max(-1, cosine))) * 180 / Math.PI;
}
function trunkLean(pelvis, neck) {
  const vector = [neck[0] - pelvis[0], neck[1] - pelvis[1], neck[2] - pelvis[2]];
  const magnitude = Math.hypot(...vector);
  if (magnitude < EPSILON) return 0;
  return Math.acos(Math.min(1, Math.max(-1, vector[1] / magnitude))) * 180 / Math.PI;
}
function range(values) { return values.length ? Math.max(...values) - Math.min(...values) : 0; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function coefficientOfVariation(values) {
  const average = mean(values);
  if (average < EPSILON) return 0;
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.sqrt(variance) / average;
}
function directionChanges(values, minimumMagnitude) {
  let lastDirection = 0;
  let changes = 0;
  for (const value of values) {
    const direction = Math.abs(value) < minimumMagnitude ? 0 : Math.sign(value);
    if (!direction) continue;
    if (lastDirection && direction !== lastDirection) changes += 1;
    lastDirection = direction;
  }
  return changes;
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function round(value, digits = 2) { return Number(value.toFixed(digits)); }
