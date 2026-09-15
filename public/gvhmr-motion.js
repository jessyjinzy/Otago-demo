import { OpenWorldActivitySupervisor } from "./open-world-activity.js";

const EPSILON = 1e-8;
const SMPL_24_NAMES = [
  "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2",
  "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot", "neck", "left_collar",
  "right_collar", "head", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hand", "right_hand",
];
export const REPLAY_FAULT_PRESETS = ["none", "lower_body_occlusion", "tracking_dropout", "periodic_frame_drop", "stream_gap"];

export function angleDegrees(a, b, c) {
  const first = subtract(a, b);
  const second = subtract(c, b);
  const cosine = dot(first, second) / Math.max(EPSILON, magnitude(first) * magnitude(second));
  return radiansToDegrees(Math.acos(clamp(cosine, -1, 1)));
}

export function trunkLeanDegrees(joints) {
  const trunk = subtract(joints.neck, joints.pelvis);
  return radiansToDegrees(Math.acos(clamp(trunk[1] / Math.max(EPSILON, magnitude(trunk)), -1, 1)));
}

export function legLength(joints, side) {
  return distance(joints[`${side}_hip`], joints[`${side}_knee`])
    + distance(joints[`${side}_knee`], joints[`${side}_ankle`]);
}

export function createGvhmrDetector(action, segment) {
  const detectorAction = perceptionAction(action);
  if (detectorAction.detector.type === "knee_bends") return new KneeBendDetector(detectorAction, segment);
  if (detectorAction.detector.type === "one_leg_stand") return new OneLegStandDetector(detectorAction, segment);
  throw new Error(`Unsupported GVHMR detector type: ${action.detector.type}`);
}

export class KneeBendDetector {
  constructor(action, segment) {
    this.action = action;
    this.segment = segment;
    this.phase = "standing";
    this.repIndex = 0;
    this.smoothedAngle = undefined;
    this.standingPelvisY = -Infinity;
    this.resetRepMetrics();
  }

  process(frame) {
    const events = [];
    const joints = frame.joints;
    const leftKnee = angleDegrees(joints.left_hip, joints.left_knee, joints.left_ankle);
    const rightKnee = angleDegrees(joints.right_hip, joints.right_knee, joints.right_ankle);
    const kneeAngle = Math.min(leftKnee, rightKnee);
    this.smoothedAngle = this.smoothedAngle === undefined
      ? kneeAngle
      : 0.32 * kneeAngle + 0.68 * this.smoothedAngle;
    const scale = (legLength(joints, "left") + legLength(joints, "right")) / 2;
    const lean = trunkLeanDegrees(joints);
    const asymmetry = Math.abs(leftKnee - rightKnee);
    const config = this.action.detector;

    if (this.phase === "standing") {
      this.standingPelvisY = Math.max(this.standingPelvisY, joints.pelvis[1]);
      if (this.smoothedAngle <= config.down_threshold_deg) {
        this.phase = "lowering";
        this.minimumKneeAngle = kneeAngle;
        this.minimumPelvisY = joints.pelvis[1];
        this.maximumAsymmetry = asymmetry;
        this.maximumTrunkLean = lean;
        events.push(motionEvent({
          actionId: "knee_bends", actionName: "Knee bends", side: this.segment.side,
          repIndex: this.repIndex + 1, phase: "rep_started", status: "correct",
          countIncrement: 0, confidence: 0.9, clipId: this.action.clip_id,
          metrics: { knee_angle_deg: round(kneeAngle, 1), source_frame: frame.source_frame },
          issues: [], summary: `Knee bend ${this.repIndex + 1} started.`,
        }));
      }
    } else {
      this.minimumKneeAngle = Math.min(this.minimumKneeAngle, kneeAngle);
      this.minimumPelvisY = Math.min(this.minimumPelvisY, joints.pelvis[1]);
      this.maximumAsymmetry = Math.max(this.maximumAsymmetry, asymmetry);
      this.maximumTrunkLean = Math.max(this.maximumTrunkLean, lean);
      if (this.smoothedAngle >= config.return_threshold_deg) {
        const hipDropRatio = Math.max(0, this.standingPelvisY - this.minimumPelvisY) / Math.max(EPSILON, scale);
        const issues = [];
        if (this.minimumKneeAngle > config.minimum_depth_deg) {
          issues.push(issue("insufficient_knee_bend", `Lowest knee angle was ${round(this.minimumKneeAngle, 1)}°, above the ${config.minimum_depth_deg}° depth threshold.`));
        }
        if (this.maximumAsymmetry > config.maximum_knee_asymmetry_deg) {
          issues.push(issue("asymmetric_knee_bend", `Left/right knee-angle difference reached ${round(this.maximumAsymmetry, 1)}°.`));
        }
        if (this.maximumTrunkLean > config.maximum_trunk_lean_deg) {
          issues.push(issue("excessive_trunk_lean", `Trunk lean reached ${round(this.maximumTrunkLean, 1)}°.`));
        }
        this.repIndex += 1;
        const event = motionEvent({
          actionId: "knee_bends",
          actionName: "Knee bends",
          side: this.segment.side,
          repIndex: this.repIndex,
          phase: "rep_completed",
          status: issues.length ? "needs_correction" : "correct",
          countIncrement: issues.length ? 0 : 1,
          confidence: issues.length ? 0.86 : 0.96,
          clipId: this.action.clip_id,
          metrics: {
            minimum_knee_angle_deg: round(this.minimumKneeAngle, 1),
            hip_drop_leg_ratio: round(hipDropRatio, 3),
            maximum_knee_asymmetry_deg: round(this.maximumAsymmetry, 1),
            maximum_trunk_lean_deg: round(this.maximumTrunkLean, 1),
            source_frame: frame.source_frame,
          },
          issues,
          summary: issues.length
            ? `Knee-bend cycle completed with ${issues[0].summary}`
            : `Valid knee bend ${this.repIndex}: controlled depth and return to standing.`,
        });
        this.phase = "standing";
        this.standingPelvisY = joints.pelvis[1];
        this.resetRepMetrics();
        return { telemetry: this.telemetry(frame, leftKnee, rightKnee, lean), events: [event] };
      }
    }

    return { telemetry: this.telemetry(frame, leftKnee, rightKnee, lean), events };
  }

  telemetry(frame, leftKnee, rightKnee, lean) {
    return {
      detector: "knee_bends",
      source_frame: frame.source_frame,
      source_time_s: frame.source_time_s,
      phase: this.phase,
      left_knee_deg: round(leftKnee, 1),
      right_knee_deg: round(rightKnee, 1),
      trunk_lean_deg: round(lean, 1),
      detected_reps: this.repIndex,
    };
  }

  resetRepMetrics() {
    this.minimumKneeAngle = Infinity;
    this.minimumPelvisY = Infinity;
    this.maximumAsymmetry = 0;
    this.maximumTrunkLean = 0;
  }
}

export class OneLegStandDetector {
  constructor(action, segment) {
    this.action = action;
    this.segment = segment;
    this.liftedSide = segment.side.startsWith("left") ? "left" : "right";
    this.stanceSide = this.liftedSide === "left" ? "right" : "left";
    this.validSeconds = 0;
    this.completed = false;
    this.stanceOrigin = undefined;
    this.pelvisRelativeOrigin = undefined;
    this.maximumStanceDrift = 0;
    this.maximumPelvisSway = 0;
    this.maximumTrunkLean = 0;
    this.wasFrameValid = false;
    this.lastProgressSecond = 0;
    this.previousSourceTime = undefined;
  }

  process(frame) {
    const joints = frame.joints;
    const config = this.action.detector;
    const scale = legLength(joints, this.stanceSide);
    const liftedAnkle = joints[`${this.liftedSide}_ankle`];
    const stanceAnkle = joints[`${this.stanceSide}_ankle`];
    const stanceFoot = joints[`${this.stanceSide}_foot`];
    const liftRatio = (liftedAnkle[1] - stanceAnkle[1]) / Math.max(EPSILON, scale);
    const lean = trunkLeanDegrees(joints);

    if (!this.stanceOrigin) this.stanceOrigin = horizontal(stanceFoot);
    const pelvisRelative = subtract(horizontal(joints.pelvis), horizontal(stanceAnkle));
    if (!this.pelvisRelativeOrigin) this.pelvisRelativeOrigin = pelvisRelative;
    const stanceDrift = distance(horizontal(stanceFoot), this.stanceOrigin) / Math.max(EPSILON, scale);
    const pelvisSway = distance(pelvisRelative, this.pelvisRelativeOrigin) / Math.max(EPSILON, scale);
    this.maximumStanceDrift = Math.max(this.maximumStanceDrift, stanceDrift);
    this.maximumPelvisSway = Math.max(this.maximumPelvisSway, pelvisSway);
    this.maximumTrunkLean = Math.max(this.maximumTrunkLean, lean);

    const nominalDelta = 1 / this.action.analysis_fps;
    const sourceTime = Number(frame.source_time_s);
    const measuredDelta = this.previousSourceTime === undefined || !Number.isFinite(sourceTime)
      ? nominalDelta
      : sourceTime - this.previousSourceTime;
    this.previousSourceTime = Number.isFinite(sourceTime) ? sourceTime : this.previousSourceTime;
    const continuityLimit = nominalDelta * 2.5 + EPSILON;
    const temporalContinuity = measuredDelta > 0 && measuredDelta <= continuityLimit;
    const frameValid = temporalContinuity
      && liftRatio >= config.minimum_lift_leg_ratio
      && stanceDrift <= config.maximum_stance_drift_leg_ratio
      && pelvisSway <= config.maximum_pelvis_sway_leg_ratio
      && lean <= config.maximum_trunk_lean_deg;
    const previousValidSeconds = this.validSeconds;
    this.validSeconds = frameValid ? this.validSeconds + measuredDelta : 0;

    const telemetry = {
      detector: "one_leg_stand",
      source_frame: frame.source_frame,
      source_time_s: frame.source_time_s,
      phase: frameValid ? "holding" : "seeking_stable_hold",
      lifted_side: this.liftedSide,
      lift_leg_ratio: round(liftRatio, 3),
      continuous_hold_s: round(this.validSeconds, 1),
      stance_drift_leg_ratio: round(stanceDrift, 3),
      pelvis_sway_leg_ratio: round(pelvisSway, 3),
      trunk_lean_deg: round(lean, 1),
      frame_delta_s: round(measuredDelta, 3),
      temporal_continuity: temporalContinuity,
    };

    const events = [];
    if (this.completed) return { telemetry, events };
    if (frameValid && !this.wasFrameValid) {
      events.push(motionEvent({
        actionId: "one_leg_stand", actionName: "One-leg stand", side: this.segment.side,
        repIndex: 1, phase: "hold_started", status: "correct", countIncrement: 0,
        confidence: 0.9, clipId: this.action.clip_id,
        metrics: { elapsed_seconds: round(this.validSeconds, 1), source_frame: frame.source_frame },
        issues: [], summary: `Stable one-leg hold started with the ${this.liftedSide} foot lifted.`,
      }));
    }

    const progressSecond = Math.floor(this.validSeconds + EPSILON);
    if (frameValid && progressSecond >= 2 && progressSecond % 2 === 0 && progressSecond !== this.lastProgressSecond && progressSecond < config.hold_seconds) {
      this.lastProgressSecond = progressSecond;
      events.push(motionEvent({
        actionId: "one_leg_stand", actionName: "One-leg stand", side: this.segment.side,
        repIndex: 1, phase: "hold_progress", status: "correct", countIncrement: 0,
        confidence: 0.94, clipId: this.action.clip_id,
        metrics: { elapsed_seconds: progressSecond, target_seconds: config.hold_seconds, source_frame: frame.source_frame },
        issues: [], summary: `Stable hold in progress: ${progressSecond} of ${config.hold_seconds} seconds.`,
      }));
    }

    if (!frameValid && this.wasFrameValid && previousValidSeconds >= 1) {
      const interruption = holdInterruptionIssue({ liftRatio, stanceDrift, pelvisSway, lean, config });
      events.push(motionEvent({
        actionId: "one_leg_stand", actionName: "One-leg stand", side: this.segment.side,
        repIndex: 1, phase: "hold_interrupted", status: "needs_correction", countIncrement: 0,
        confidence: 0.88, clipId: this.action.clip_id,
        metrics: { elapsed_before_interruption_seconds: round(previousValidSeconds, 1), source_frame: frame.source_frame },
        issues: [interruption], summary: `The hold was interrupted after ${round(previousValidSeconds, 1)} seconds: ${interruption.summary}`,
      }));
      this.lastProgressSecond = 0;
    }
    this.wasFrameValid = frameValid;

    if (this.validSeconds + EPSILON < config.hold_seconds) return { telemetry, events };
    this.completed = true;
    events.push(motionEvent({
      actionId: "one_leg_stand",
      actionName: "One-leg stand",
      side: this.segment.side,
      repIndex: 1,
      phase: "hold_completed",
      status: "correct",
      countIncrement: 1,
      confidence: 0.95,
      clipId: this.action.clip_id,
      metrics: {
        hold_seconds: round(this.validSeconds, 1),
        lifted_ankle_height_leg_ratio: round(liftRatio, 3),
        maximum_stance_drift_leg_ratio: round(this.maximumStanceDrift, 3),
        maximum_pelvis_sway_leg_ratio: round(this.maximumPelvisSway, 3),
        maximum_trunk_lean_deg: round(this.maximumTrunkLean, 1),
        source_frame: frame.source_frame,
      },
      issues: [],
      summary: `Valid ${config.hold_seconds}-second one-leg stand with the ${this.liftedSide} foot lifted.`,
    }));
    return {
      telemetry,
      events,
    };
  }
}

export class GlobalMotionMonitor {
  constructor(action, segment) {
    this.action = perceptionAction(action);
    this.segment = segment;
    this.requiredJoints = [
      "pelvis", "neck",
      "left_hip", "right_hip", "left_knee", "right_knee",
      "left_ankle", "right_ankle", "left_foot", "right_foot",
    ];
    this.baselinePelvisY = -Infinity;
    this.previousPelvis = undefined;
    this.previousTime = undefined;
    this.lastFrameTime = undefined;
    this.lastRecognizedTime = undefined;
    this.trackingLostSince = undefined;
    this.lowConfidenceSince = undefined;
    this.frameGapTimes = [];
    this.personId = undefined;
    this.emitted = new Set();
    this.activitySupervisor = new OpenWorldActivitySupervisor({
      expectedActionId: this.action.id,
      analysisFps: this.action.analysis_fps,
    });
    this.lastActivityObservation = this.activitySupervisor.lastObservation;
  }

  preflight(frame) {
    const sourceTime = Number(frame?.source_time_s || 0);
    if (frame?.person_id && this.personId && frame.person_id !== this.personId) {
      const previous = this.personId;
      this.personId = frame.person_id;
      return { blocked: true, events: [this.globalEvent(frame, "identity_changed", "uncertain", `Tracked participant changed from ${previous} to ${frame.person_id}.`, "high")] };
    }
    if (frame?.person_id && !this.personId) this.personId = frame.person_id;

    if (this.lastFrameTime !== undefined && sourceTime < this.lastFrameTime - EPSILON) {
      const events = this.emitted.has("out_of_order_frame")
        ? []
        : [this.globalEvent(frame, "out_of_order_frame", "uncertain", "The joint stream timestamp moved backwards; this frame was not used for motion progress.", "moderate")];
      this.emitted.add("out_of_order_frame");
      return { blocked: true, events };
    }
    const gapSeconds = this.lastFrameTime === undefined ? 0 : sourceTime - this.lastFrameTime;
    this.lastFrameTime = sourceTime;
    if (gapSeconds > 1.5 && !this.emitted.has("stream_gap")) {
      this.emitted.add("stream_gap");
      this.previousPelvis = undefined;
      return { blocked: true, events: [this.globalEvent(frame, "stream_gap", "uncertain", `The joint stream has a ${round(gapSeconds, 1)}-second gap.`, "high")] };
    }

    // Tolerate one late sample, but surface persistent frame loss so vision can
    // verify the same participant instead of trusting degraded motion alone.
    const expectedInterval = 1 / Math.max(1, Number(this.action.analysis_fps) || 5);
    if (gapSeconds > expectedInterval * 1.65) this.frameGapTimes.push(sourceTime);
    this.frameGapTimes = this.frameGapTimes.filter((time) => sourceTime - time <= 2);
    if (this.frameGapTimes.length >= 3 && !this.emitted.has("frame_loss")) {
      this.emitted.add("frame_loss");
      return { blocked: true, events: [this.globalEvent(frame, "frame_loss", "uncertain", "Motion frames have been repeatedly dropped during the last two seconds.", "high")] };
    }
    if (!this.frameGapTimes.length) this.emitted.delete("frame_loss");

    if (Number.isFinite(Number(frame?.tracking_confidence)) && Number(frame.tracking_confidence) < 0.5) {
      if (this.lowConfidenceSince === undefined) this.lowConfidenceSince = sourceTime;
      if (sourceTime - this.lowConfidenceSince >= 1 && !this.emitted.has("tracking_unreliable")) {
        this.emitted.add("tracking_unreliable");
        return { blocked: true, events: [this.globalEvent(frame, "tracking_unreliable", "uncertain", "Pose tracking confidence remained below 0.5 for at least one second.", "high")] };
      }
      return { blocked: true, events: [] };
    } else {
      this.lowConfidenceSince = undefined;
      this.emitted.delete("tracking_unreliable");
    }
    if (!hasFiniteJoints(frame?.joints, this.requiredJoints)) {
      if (this.trackingLostSince === undefined) this.trackingLostSince = sourceTime;
      if (sourceTime - this.trackingLostSince >= 1 && !this.emitted.has("tracking_lost")) {
        this.emitted.add("tracking_lost");
        return { blocked: true, events: [this.globalEvent(frame, "tracking_lost", "uncertain", "Required body joints have been missing or invalid for at least one second.", "high")] };
      }
      return { blocked: true, events: [] };
    }

    this.trackingLostSince = undefined;
    return { blocked: false, events: [] };
  }

  inspect(frame, telemetry, actionEvents = [], { preflightDone = false } = {}) {
    const gate = preflightDone ? { blocked: false, events: [] } : this.preflight(frame);
    if (gate.blocked) return gate.events;
    const sourceTime = Number(frame?.source_time_s || 0);
    const joints = frame.joints;
    const scale = Math.max(EPSILON, (legLength(joints, "left") + legLength(joints, "right")) / 2);
    const pelvisY = joints.pelvis[1];
    const lean = trunkLeanDegrees(joints);
    this.baselinePelvisY = Math.max(this.baselinePelvisY, pelvisY);

    const elapsed = this.previousTime === undefined ? 0 : Math.max(EPSILON, sourceTime - this.previousTime);
    const downwardSpeed = this.previousPelvis ? Math.max(0, this.previousPelvis[1] - pelvisY) / scale / elapsed : 0;
    const heightDrop = Math.max(0, this.baselinePelvisY - pelvisY) / scale;
    this.previousPelvis = joints.pelvis;
    this.previousTime = sourceTime;

    if ((downwardSpeed > 1.4 && lean > 50) || (heightDrop > 0.65 && lean > 60)) {
      if (!this.emitted.has("possible_fall")) {
        this.emitted.add("possible_fall");
        return [this.globalEvent(frame, "possible_fall", "uncertain", `Possible fall pattern: rapid pelvis descent (${round(downwardSpeed, 2)} leg-lengths/s), height drop ${round(heightDrop, 2)}, trunk lean ${round(lean, 1)}°.`, "critical")];
      }
    }

    const activityResult = this.activitySupervisor.observe(frame, telemetry, actionEvents);
    this.lastActivityObservation = activityResult.observation;

    if (this.lastRecognizedTime === undefined) this.lastRecognizedTime = sourceTime;
    if (actionEvents.length || ["lowering", "holding"].includes(telemetry?.phase)) {
      this.lastRecognizedTime = sourceTime;
      this.emitted.delete("no_recognized_activity");
      this.emitted.delete("activity_hypothesis");
    }
    const noProgressSeconds = sourceTime - this.lastRecognizedTime;
    if (activityResult.shouldEmit && !this.emitted.has("activity_hypothesis")) {
      this.emitted.add("activity_hypothesis");
      const hypotheses = activityResult.observation.hypotheses.map((item) => `${item.label} ${Math.round(item.confidence * 100)}%`).join(", ");
      return [this.globalEvent(
        frame,
        "activity_hypothesis",
        "uncertain",
        `Expected ${this.action.id} is not yet explained; motion hypotheses: ${hypotheses}.`,
        "moderate",
        { activity_supervisor: activityResult.observation },
      )];
    }
    return [];
  }

  invalidFrameTelemetry(frame) {
    return { detector: "global_monitor", source_frame: frame?.source_frame, source_time_s: frame?.source_time_s, phase: "tracking_unreliable" };
  }

  globalEvent(frame, code, status, summary, severity, extraMetrics = {}) {
    const confidence = status === "safety_concern" || severity === "critical" ? 0.9 : 0.7;
    return motionEvent({
      actionId: this.action.id, actionName: this.action.name || this.action.id, side: this.segment.side,
      repIndex: null, phase: code, status, countIncrement: 0,
      confidence, clipId: this.action.clip_id,
      metrics: { source_frame: frame?.source_frame, source_time_s: frame?.source_time_s, ...extraMetrics },
      issues: [{ code, severity, confidence, summary }], summary,
    });
  }
}

export class GvhmrReplayEngine {
  constructor({ dataUrl, pushEvent, onStatus = () => {}, onTelemetry = () => {}, onEvent = () => {}, playbackSpeed = 1, watchdogThresholdMs = 2500 }) {
    this.dataUrl = dataUrl;
    this.pushEvent = pushEvent;
    this.onStatus = onStatus;
    this.onTelemetry = onTelemetry;
    this.onEvent = onEvent;
    this.playbackSpeed = playbackSpeed;
    this.completedKeys = new Set();
    // Recorded inputs are a researcher-controlled test source. Entering an
    // active set only prepares an input; playback always starts explicitly.
    this.autoPlay = false;
    this.paused = false;
    this.externalStreamActive = false;
    this.liveActive = undefined;
    this.liveTimeOriginMs = undefined;
    this.replaySources = new Map();
    this.replayQueue = [];
    this.queueCursor = 0;
    this.queueAssignments = new Map();
    this.pendingOverride = undefined;
    this.watchdogThresholdMs = Math.max(10, Number(watchdogThresholdMs) || 2500);
    this.streamWatchdogTimer = undefined;
    this.streamWatchdogToken = undefined;
    this.streamWatchdogEmitted = false;
  }

  async load() {
    const response = await fetch(this.dataUrl);
    if (!response.ok) throw new Error(`Could not load compact GVHMR stream (${response.status}).`);
    this.dataset = await response.json();
    validateReplayDataset(this.dataset);
    this.registerDataset(this.dataset, "Built-in GVHMR demo", "builtin");
    return this.dataset;
  }

  registerDataset(dataset, label = "Additional GVHMR source", sourceId) {
    validateReplayDataset(dataset);
    const id = sourceId || `imported-${Date.now()}-${this.replaySources.size}`;
    this.replaySources.set(id, { id, label: String(label || id), dataset });
    return { source_id: id, label: String(label || id), clips: this.listClips().filter((clip) => clip.source_id === id) };
  }

  listClips() {
    const clips = [];
    for (const source of this.replaySources.values()) {
      for (const [actionId, action] of Object.entries(source.dataset.actions || {})) {
        for (const segment of action.segments || []) {
          clips.push({
            id: `${source.id}:${actionId}:${segment.segment_id}`,
            source_id: source.id,
            source_label: source.label,
            action_id: actionId,
            action_name: action.name || actionId,
            segment_id: segment.segment_id,
            set_id: segment.set_id,
            side: segment.side,
            frame_count: segment.frames.length,
            analysis_fps: Number(action.analysis_fps),
          });
        }
      }
    }
    return clips;
  }

  setReplayQueue(entries = []) {
    const known = new Set(this.listClips().map((clip) => clip.id));
    this.replayQueue = entries.map((entry, index) => ({
      id: String(entry.id || `queue-${index + 1}`),
      clip_id: String(entry.clip_id || ""),
      fault_preset: String(entry.fault_preset || "none"),
      startup_delay_ms: clamp(Number(entry.startup_delay_ms) || 0, 0, 30_000),
    }));
    const missing = this.replayQueue.find((entry) => !known.has(entry.clip_id));
    if (missing) throw new Error(`Unknown replay clip ${missing.clip_id}.`);
    const unsupportedFault = this.replayQueue.find((entry) => !REPLAY_FAULT_PRESETS.includes(entry.fault_preset));
    if (unsupportedFault) throw new Error(`Unsupported replay fault preset ${unsupportedFault.fault_preset}.`);
    this.queueCursor = 0;
    this.queueAssignments.clear();
    return this.getReplayQueue();
  }

  replaceCurrentOrNext(entry, snapshot = this.snapshot, { deferStart = false } = {}) {
    const normalized = {
      id: String(entry?.id || `immediate-${Date.now()}`),
      clip_id: String(entry?.clip_id || ""),
      fault_preset: String(entry?.fault_preset || "none"),
      startup_delay_ms: clamp(Number(entry?.startup_delay_ms) || 0, 0, 30_000),
    };
    if (!this.listClips().some((clip) => clip.id === normalized.clip_id)) throw new Error(`Unknown replay clip ${normalized.clip_id}.`);
    if (!REPLAY_FAULT_PRESETS.includes(normalized.fault_preset)) throw new Error(`Unsupported replay fault preset ${normalized.fault_preset}.`);
    if (snapshot) this.snapshot = snapshot;
    const activeSet = snapshot?.current_state === "active_set";
    if (!activeSet) {
      this.pendingOverride = normalized;
      this.onStatus({ state: "ready", message: "Selected reconstruction staged for the next active set." });
      return { mode: "staged_for_next_active_set" };
    }
    const key = `${snapshot.run_number}:${snapshot.current_exercise?.id}:${snapshot.current_set?.set_id}`;
    this.queueAssignments.set(key, normalized);
    this.completedKeys.delete(key);
    const resolved = this.resolve(snapshot);
    if (!resolved) throw new Error("The current active set has no detector mapping.");
    if (deferStart) {
      this.onStatus({ state: "ready", message: `Selected reconstruction will start after the coach's start cue for ${resolved.actionName}.`, ...resolved });
      return { mode: "replaced_pending", key };
    }
    if (this.active?.key === key) {
      return this.switchActiveInput(resolved);
    }
    if (this.autoPlay) {
      void this.start(resolved).catch((error) => {
        this.stop(`Replay replacement failed: ${error.message}`);
        this.onStatus({ state: "error", message: error.message, ...resolved });
      });
      return { mode: "replaced_current", key };
    }
    this.stop();
    this.onStatus({ state: "ready", message: `Selected reconstruction is ready for ${resolved.actionName}.`, ...resolved });
    return { mode: "replaced_current_paused", key };
  }

  switchActiveInput(resolved) {
    const active = this.active;
    if (!active || active.key !== resolved.key) throw new Error("No matching active sensor stream is available to switch.");
    if (active.timer) clearTimeout(active.timer);
    active.timer = undefined;

    const lastFrame = active.segment.frames[Math.max(0, active.frameIndex - 1)];
    const streamFps = Math.max(1, Number(resolved.action.analysis_fps) || Number(active.streamAnalysisFps) || 1);
    const nextTime = Number(lastFrame?.source_time_s || 0) + (1 / streamFps);
    active.segment = {
      ...resolved.segment,
      frames: continueFrameTimeline(resolved.segment.frames, nextTime),
    };
    active.replaySource = resolved.replaySource;
    active.startupDelayMs = resolved.startupDelayMs;
    active.streamAnalysisFps = streamFps;
    active.frameIndex = 0;

    // Deliberately retain active.detector and active.globalMonitor. To the
    // perception pipeline this is one uninterrupted sensor stream; only the
    // future frames changed, just as they would if a participant changed action.
    this.beatStreamWatchdog(active);
    const mode = this.paused ? "replaced_current_paused" : "replaced_current";
    this.onStatus({
      state: mode === "replaced_current" ? "streaming" : "paused",
      message: `Incoming replay frames switched to ${resolved.replaySource.source_label} / ${resolved.replaySource.source_segment_id}. Detector state was not reset.`,
      ...active,
    });
    if (mode === "replaced_current") {
      active.timer = setTimeout(() => void this.tick(active.token), resolved.startupDelayMs || 0);
    }
    return { mode, key: active.key };
  }

  getReplayQueue() { return structuredClone(this.replayQueue); }

  setPlaybackSpeed(speed) {
    this.playbackSpeed = clamp(Number(speed) || 1, 0.25, 20);
  }

  setAutoPlay(enabled) {
    this.autoPlay = Boolean(enabled);
    if (!this.autoPlay) this.stop("Automatic replay disabled.");
  }

  reset() {
    this.paused = false;
    this.externalStreamActive = false;
    this.liveActive = undefined;
    this.liveTimeOriginMs = undefined;
    this.stop("Waiting for an active prescribed set.");
    this.completedKeys.clear();
    this.queueCursor = 0;
    this.queueAssignments.clear();
    this.pendingOverride = undefined;
  }

  sync(snapshot, { force = false } = {}) {
    this.snapshot = snapshot;
    if (this.externalStreamActive) {
      const expected = this.resolve(snapshot);
      if (expected && this.streamWatchdogToken !== expected.key) this.armStreamWatchdog(expected);
      else if (!expected) this.stopStreamWatchdog();
      return;
    }
    const resolved = this.resolve(snapshot);
    if (!resolved) {
      if (this.active) this.stop("Waiting for a selected motion-demo action.");
      return;
    }
    const { key } = resolved;
    if (!force && (this.completedKeys.has(key) || this.active?.key === key)) return;
    if (!force && !this.autoPlay) {
      this.onStatus({ state: "ready", message: `GVHMR clip ready for ${resolved.actionName}.`, ...resolved });
      return;
    }
    void this.start(resolved).catch((error) => {
      this.stop(`Replay failed: ${error.message}`);
      this.onStatus({ state: "error", message: error.message, ...resolved });
    });
  }

  replayCurrent() {
    const resolved = this.resolve(this.snapshot);
    if (!resolved) throw new Error("The controller is not in an active set with a mapped GVHMR clip.");
    this.completedKeys.delete(resolved.key);
    this.sync(this.snapshot, { force: true });
  }

  resolve(snapshot) {
    if (!this.dataset || snapshot?.current_state !== "active_set") return null;
    const actionId = snapshot.current_exercise?.id;
    const expectedAction = this.dataset.actions?.[actionId];
    if (!expectedAction) return null;
    const setId = snapshot.current_set?.set_id;
    const expectedSegment = expectedAction.segments.find((item) => item.set_id === setId) || expectedAction.segments[0];
    if (!expectedSegment) return null;
    const key = `${snapshot.run_number}:${actionId}:${setId}`;
    let assignment = this.queueAssignments.get(key);
    if (!assignment && this.pendingOverride) {
      assignment = this.pendingOverride;
      this.pendingOverride = undefined;
      this.queueAssignments.set(key, assignment);
    }
    if (!assignment && this.queueCursor < this.replayQueue.length) {
      assignment = this.replayQueue[this.queueCursor];
      this.queueCursor += 1;
      this.queueAssignments.set(key, assignment);
    }
    const selected = assignment ? this.resolveQueuedClip(assignment) : null;
    const sourceAction = selected?.action || expectedAction;
    const sourceSegment = selected?.segment || expectedSegment;
    const segment = applyReplayFault(sourceSegment, assignment?.fault_preset || "none", {
      setId,
      side: expectedSegment.side,
    });
    const action = {
      // The detector remains prescription-specific, even when a deliberately
      // mismatched replay clip is supplied. Global/open-world events therefore
      // belong to the expected action and must carry its canonical identity.
      id: actionId,
      name: snapshot.current_exercise?.name || actionId,
      analysis_fps: Number(sourceAction.analysis_fps) || Number(expectedAction.analysis_fps),
      detector: structuredClone(expectedAction.detector),
    };
    return {
      key,
      actionId,
      actionName: snapshot.current_exercise?.name || actionId,
      setId,
      action,
      segment,
      replaySource: selected?.descriptor || {
        clip_id: `builtin:${actionId}:${expectedSegment.segment_id}`,
        source_label: "Built-in prescription-matched clip",
        source_action_id: actionId,
        source_segment_id: expectedSegment.segment_id,
        fault_preset: "none",
        startup_delay_ms: 0,
      },
      startupDelayMs: assignment?.startup_delay_ms || 0,
    };
  }

  resolveQueuedClip(assignment) {
    const descriptor = this.listClips().find((clip) => clip.id === assignment.clip_id);
    if (!descriptor) throw new Error(`Replay queue references unavailable clip ${assignment.clip_id}.`);
    const source = this.replaySources.get(descriptor.source_id);
    const action = source.dataset.actions[descriptor.action_id];
    const segment = action.segments.find((item) => item.segment_id === descriptor.segment_id);
    return {
      action,
      segment,
      descriptor: {
        clip_id: descriptor.id,
        source_label: descriptor.source_label,
        source_action_id: descriptor.action_id,
        source_segment_id: descriptor.segment_id,
        fault_preset: assignment.fault_preset,
        startup_delay_ms: assignment.startup_delay_ms,
      },
    };
  }

  async start(resolved) {
    this.stop();
    this.paused = false;
    const token = Symbol(resolved.key);
    const detector = createGvhmrDetector(resolved.action, resolved.segment);
    const globalMonitor = new GlobalMotionMonitor(resolved.action, resolved.segment);
    this.active = { ...resolved, token, detector, globalMonitor, frameIndex: 0, streamAnalysisFps: resolved.action.analysis_fps };
    this.armStreamWatchdog(resolved);
    const firstFrame = resolved.segment.frames[0]?.source_frame;
    const lastFrame = resolved.segment.frames.at(-1)?.source_frame;
    this.onStatus({
      state: resolved.startupDelayMs ? "ready" : "streaming",
      message: `${resolved.startupDelayMs ? `Waiting ${resolved.startupDelayMs} ms before replaying` : "Replaying"} ${resolved.replaySource.source_label} / ${resolved.replaySource.source_segment_id} as input for expected ${resolved.actionName}; fault=${resolved.replaySource.fault_preset}.`,
      ...resolved,
    });
    if (resolved.startupDelayMs) {
      this.active.timer = setTimeout(() => void this.tick(token), resolved.startupDelayMs);
      return;
    }
    await this.tick(token);
  }

  setExternalStreamActive(enabled) {
    this.externalStreamActive = Boolean(enabled);
    if (this.externalStreamActive) {
      this.stop("Live joint stream connected; recorded replay is suspended.");
      this.liveActive = undefined;
      this.liveTimeOriginMs = undefined;
    } else {
      this.stopStreamWatchdog();
      this.liveActive = undefined;
      this.liveTimeOriginMs = undefined;
    }
  }

  async processLiveFrame(input) {
    if (!this.dataset) throw new Error("Motion detector configuration is not loaded.");
    const resolved = this.resolve(this.snapshot);
    if (!resolved) throw new Error("Raw joint frames are accepted only during a mapped active_set.");
    if (this.snapshot?.motion_awareness?.supervisory_pause) {
      return { telemetry: { detector: "supervisor", phase: "paused_for_confirmation" }, events: [] };
    }
    this.externalStreamActive = true;
    if (!this.liveActive || this.liveActive.key !== resolved.key) {
      this.stop();
      this.liveActive = {
        ...resolved,
        live: true,
        detector: createGvhmrDetector(resolved.action, resolved.segment),
        globalMonitor: new GlobalMotionMonitor(resolved.action, resolved.segment),
        receivedFrames: 0,
      };
      this.liveTimeOriginMs = Number(input.timestamp_ms || Date.now());
      this.armStreamWatchdog(resolved);
    }
    this.beatStreamWatchdog(resolved);

    const frame = normalizeLiveJointFrame(input, this.liveTimeOriginMs, this.liveActive.receivedFrames, resolved.action.analysis_fps);
    this.liveActive.receivedFrames += 1;
    const gate = this.liveActive.globalMonitor.preflight(frame);
    const result = gate.blocked
      ? { telemetry: this.liveActive.globalMonitor.invalidFrameTelemetry(frame), events: [] }
      : this.liveActive.detector.process(frame);
    const globalEvents = gate.blocked
      ? gate.events
      : this.liveActive.globalMonitor.inspect(frame, result.telemetry, result.events, { preflightDone: true });
    result.telemetry = {
      ...result.telemetry,
      activity_supervisor: this.liveActive.globalMonitor.lastActivityObservation,
    };
    result.events = globalEvents.some((event) => event.assessment.status === "safety_concern" || event.observation.phase === "possible_fall")
      ? globalEvents
      : [...globalEvents, ...result.events];
    this.onTelemetry(result.telemetry, {
      ...this.liveActive,
      frameIndex: this.liveActive.receivedFrames,
      segment: { frames: { length: Math.max(this.liveActive.receivedFrames, 1) } },
      live: true,
    });
    for (const event of result.events) {
      this.onEvent(event, this.liveActive);
      await this.pushEvent(event);
    }
    return result;
  }

  async tick(token) {
    const active = this.active;
    if (!active || active.token !== token || this.paused) return;
    if (active.frameIndex >= active.segment.frames.length) {
      this.stop("Clip ended before the prescribed target was detected.");
      this.onStatus({ state: "warning", message: "Clip ended before the prescribed target was detected.", ...active });
      return;
    }

    const frame = active.segment.frames[active.frameIndex];
    this.beatStreamWatchdog(active);
    active.frameIndex += 1;
    const gate = active.globalMonitor.preflight(frame);
    const result = gate.blocked
      ? { telemetry: active.globalMonitor.invalidFrameTelemetry(frame), events: [] }
      : active.detector.process(frame);
    const globalEvents = gate.blocked
      ? gate.events
      : active.globalMonitor.inspect(frame, result.telemetry, result.events, { preflightDone: true });
    result.telemetry = {
      ...result.telemetry,
      activity_supervisor: active.globalMonitor.lastActivityObservation,
    };
    result.events = globalEvents.some((event) => event.assessment.status === "safety_concern" || event.observation.phase === "possible_fall")
      ? globalEvents
      : [...globalEvents, ...result.events];
    this.onTelemetry(result.telemetry, active);

    for (const event of result.events) {
      this.onEvent(event, active);
      await this.pushEvent(event);
      if (!this.active || this.active.token !== token || this.paused) return;
      if (event.assessment.status === "correct" && event.observation.phase === "hold_completed") {
        this.completedKeys.add(active.key);
        this.stop("Motion target detected and sent to the coach.");
        return;
      }
    }

    const target = Number(this.snapshot?.current_set?.repetitions || 0);
    const authoritativeCount = Number(this.snapshot?.observed_count || 0);
    if (active.actionId === "knee_bends" && target > 0 && authoritativeCount >= target) {
      this.completedKeys.add(active.key);
      this.stop("Motion target detected and sent to the coach.");
      return;
    }

    if (this.paused) return;
    const interval = 1000 / ((active.streamAnalysisFps || active.action.analysis_fps) * this.playbackSpeed);
    active.timer = setTimeout(() => void this.tick(token), interval);
  }

  pause(message = "Motion replay paused.") {
    this.paused = true;
    if (this.active?.timer) clearTimeout(this.active.timer);
    if (this.active) this.active.timer = undefined;
    this.stopStreamWatchdog();
    this.onStatus({ state: "paused", message, ...(this.active || {}) });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (!this.active) return;
    this.armStreamWatchdog(this.active);
    this.onStatus({ state: "streaming", message: `Resuming ${this.active.actionName} from frame ${this.active.frameIndex + 1}.`, ...this.active });
    void this.tick(this.active.token);
  }

  stop(message) {
    if (this.active?.timer) clearTimeout(this.active.timer);
    this.stopStreamWatchdog();
    this.active = undefined;
    if (message) this.onStatus({ state: "idle", message });
  }

  armStreamWatchdog(context) {
    this.stopStreamWatchdog();
    if (!context?.key) return;
    this.streamWatchdogToken = context.key;
    this.streamWatchdogEmitted = false;
    this.scheduleStreamWatchdog(context);
  }

  beatStreamWatchdog(context) {
    if (!context?.key) return;
    if (this.streamWatchdogToken !== context.key) {
      this.armStreamWatchdog(context);
      return;
    }
    if (this.streamWatchdogEmitted) return;
    clearTimeout(this.streamWatchdogTimer);
    this.scheduleStreamWatchdog(context);
  }

  scheduleStreamWatchdog(context) {
    const token = context.key;
    this.streamWatchdogTimer = setTimeout(() => {
      this.streamWatchdogTimer = undefined;
      if (this.streamWatchdogToken !== token || this.streamWatchdogEmitted || this.paused) return;
      this.streamWatchdogEmitted = true;
      const seconds = round(this.watchdogThresholdMs / 1000, 1);
      const event = motionEvent({
        actionId: context.actionId,
        actionName: context.actionName,
        side: context.segment?.side,
        repIndex: null,
        phase: "stream_stalled",
        status: "uncertain",
        countIncrement: 0,
        confidence: 0.98,
        clipId: context.action?.clip_id,
        metrics: { silence_seconds: seconds, wall_clock_watchdog: true },
        issues: [{ code: "no_motion_frames", severity: "high", confidence: 0.98, summary: `No motion frame arrived for ${seconds} seconds.` }],
        summary: `The motion stream has supplied no frame for ${seconds} seconds.`,
      });
      this.onEvent(event, context);
      void Promise.resolve(this.pushEvent(event)).catch((error) => {
        this.onStatus({ state: "error", message: `Motion-stream watchdog failed: ${error.message}`, ...context });
      });
    }, this.watchdogThresholdMs);
    this.streamWatchdogTimer?.unref?.();
  }

  stopStreamWatchdog() {
    clearTimeout(this.streamWatchdogTimer);
    this.streamWatchdogTimer = undefined;
    this.streamWatchdogToken = undefined;
    this.streamWatchdogEmitted = false;
  }
}

function motionEvent({ actionId, actionName, side, repIndex, phase, status, countIncrement, confidence, clipId, metrics, issues, summary }) {
  return {
    exercise: { id: actionId, name: actionName, side, rep_index: repIndex },
    observation: { phase, confidence, valid_count_increment: countIncrement, metrics },
    assessment: { status, issues, requires_response: status !== "correct", summary },
  };
}

function continueFrameTimeline(frames, nextTime) {
  if (!frames.length) return [];
  const firstTime = Number(frames[0].source_time_s || 0);
  return frames.map((frame) => ({
    ...frame,
    input_source_time_s: Number(frame.source_time_s || 0),
    source_time_s: nextTime + Math.max(0, Number(frame.source_time_s || 0) - firstTime),
  }));
}

function perceptionAction(action = {}) {
  return {
    id: String(action.id || "current_exercise"),
    name: String(action.name || action.id || "Current exercise"),
    analysis_fps: Number(action.analysis_fps) || 5,
    detector: structuredClone(action.detector || {}),
  };
}

function issue(code, summary) {
  return { code, severity: "moderate", confidence: 0.86, summary };
}

function holdInterruptionIssue({ liftRatio, stanceDrift, pelvisSway, lean, config }) {
  if (liftRatio < config.minimum_lift_leg_ratio) return issue("lifted_foot_lowered", "The lifted foot came down before the prescribed hold finished.");
  if (stanceDrift > config.maximum_stance_drift_leg_ratio) return issue("stance_foot_moved", "The stance foot moved beyond the stable range.");
  if (pelvisSway > config.maximum_pelvis_sway_leg_ratio) return issue("excessive_pelvis_sway", "Pelvis sway exceeded the stable range.");
  if (lean > config.maximum_trunk_lean_deg) return issue("excessive_trunk_lean", "Trunk lean exceeded the stable range.");
  return issue("hold_interrupted", "The stable one-leg hold was interrupted.");
}

function hasFiniteJoints(joints, names) {
  return Boolean(joints) && names.every((name) => Array.isArray(joints[name])
    && joints[name].length >= 3
    && joints[name].slice(0, 3).every(Number.isFinite));
}

function normalizeLiveJointFrame(input, originMs, frameIndex, fallbackFps) {
  const array = input.joints3d_global || input.joints_3d || (Array.isArray(input.joints) ? input.joints : null);
  const joints = array
    ? Object.fromEntries(SMPL_24_NAMES.map((name, index) => [name, array[index]]))
    : input.joints;
    const timestampMs = Number(input.timestamp_ms || Date.now());
  const fps = Math.max(1, Number(input.fps || input.analysis_fps || fallbackFps));
  return {
    source_frame: Number(input.source_frame ?? input.frame_index ?? frameIndex),
    source_time_s: Number.isFinite(Number(input.source_time_s))
      ? Number(input.source_time_s)
      : Math.max(0, (timestampMs - originMs) / 1000),
    delta_s: Number(input.delta_s) || 1 / fps,
    person_id: input.person_id ? String(input.person_id) : undefined,
    tracking_confidence: Number.isFinite(Number(input.tracking_confidence)) ? Number(input.tracking_confidence) : undefined,
    joints,
  };
}

function validateReplayDataset(dataset) {
  if (!dataset || typeof dataset !== "object" || !dataset.actions || typeof dataset.actions !== "object") {
    throw new Error("Replay JSON must contain an actions object.");
  }
  const actions = Object.entries(dataset.actions);
  if (!actions.length) throw new Error("Replay JSON contains no actions.");
  for (const [actionId, action] of actions) {
    if (!Number.isFinite(Number(action.analysis_fps)) || Number(action.analysis_fps) <= 0) throw new Error(`${actionId} requires a positive analysis_fps.`);
    if (!Array.isArray(action.segments) || !action.segments.length) throw new Error(`${actionId} requires at least one segment.`);
    for (const segment of action.segments) {
      if (!segment.segment_id || !Array.isArray(segment.frames) || !segment.frames.length) throw new Error(`${actionId} contains an invalid segment.`);
      const badFrame = segment.frames.find((frame) => !frame?.joints || typeof frame.joints !== "object");
      if (badFrame) throw new Error(`${actionId}/${segment.segment_id} contains a frame without joint coordinates.`);
    }
  }
}

function applyReplayFault(sourceSegment, preset, { setId, side }) {
  let frames = sourceSegment.frames;
  if (preset === "periodic_frame_drop") {
    frames = frames.filter((_, index) => index % 4 !== 3);
  } else if (preset === "stream_gap") {
    const gapAt = Math.floor(frames.length * 0.4);
    frames = frames.map((sourceFrame, index) => index < gapAt ? sourceFrame : {
      ...sourceFrame,
      source_time_s: Number(sourceFrame.source_time_s || 0) + 2,
    });
  } else if (preset !== "none") {
    const start = Math.floor(frames.length * 0.25);
    const end = Math.max(start + 1, Math.floor(frames.length * 0.6));
    frames = frames.map((sourceFrame, index) => {
      if (index < start || index >= end) return sourceFrame;
      if (preset === "tracking_dropout") return { ...sourceFrame, tracking_confidence: 0.25 };
      if (preset === "lower_body_occlusion") {
        const joints = { ...sourceFrame.joints };
        for (const name of ["left_knee", "right_knee", "left_ankle", "right_ankle", "left_foot", "right_foot"]) delete joints[name];
        return { ...sourceFrame, joints };
      }
      return sourceFrame;
    });
  }
  return {
    ...sourceSegment,
    set_id: setId,
    side,
    frames,
    replay_fault: preset,
  };
}

function horizontal(point) { return [point[0], point[2]]; }
function subtract(a, b) { return a.map((value, index) => value - b[index]); }
function dot(a, b) { return a.reduce((sum, value, index) => sum + value * b[index], 0); }
function magnitude(vector) { return Math.sqrt(dot(vector, vector)); }
function distance(a, b) { return magnitude(subtract(a, b)); }
function radiansToDegrees(value) { return value * 180 / Math.PI; }
function round(value, digits = 2) { return Number(value.toFixed(digits)); }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
