import { getActionInstruction, getSystemInstruction, listSupportedActionIds } from "./instruction-library.mjs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
export const DEMO_PRESCRIPTION = Object.freeze(JSON.parse(readFileSync(resolve(rootDir, "prescriptions/demo-prescription.json"), "utf8")));
export const INITIAL_OTAGO_STATE = "greeting";

const EVENT_NAMES = [
  "greeting_ready", "readiness_completed", "plan_understood", "warm_up_result",
  "prepare_exercise", "skip_exercise", "set_readiness_result", "motion_observation",
  "perception_check_result", "set_completed", "rest_complete", "extend_rest", "end_early", "new_session_requested",
];
const STATUSES = ["none", "completed", "skipped", "pause", "ready", "correction_needed", "valid", "valid_with_correction", "valid_with_recovery", "retry", "unknown", "safe_to_continue", "needs_rest", "confirmed_safety_concern"];
const SAFETY_CONCERNS = ["pain", "dizziness", "chest_pain", "severe_shortness_of_breath", "fall", "instability", "fainting", "unsafe_setup", "other"];
const VISUAL_ACTIVITIES = [
  "performing_expected_exercise", "preparing_to_start", "adjusting_equipment", "resting",
  "inactive_but_present", "wrong_exercise", "unexpected_sitting", "left_frame",
  "partially_occluded", "tracking_failure", "unstable_recovery", "possible_fall", "unknown",
];

export function createOtagoController({ prescription = DEMO_PRESCRIPTION } = {}) {
  let plan = normalizePrescription(prescription);
  let phase = "greeting";
  let mode = null;
  let warmUpIndex = 0;
  let exerciseIndex = 0;
  let setIndex = 0;
  let observedCount = 0;
  let stopReason = null;
  let runNumber = 1;
  let motionAwareness = freshMotionAwareness();
  const outcomes = [];
  const history = [{ at: Date.now(), type: "cursor", from: null, to: stateName(), reason: "session_started" }];

  const currentWarmUp = () => plan.warm_up[warmUpIndex] || null;
  const currentExercise = () => plan.exercises[exerciseIndex] || null;
  const currentSet = () => currentExercise()?.set_sequence?.[setIndex] || null;

  function stateName() {
    if (phase === "warm_up") return "warm_up_sequence";
    if (phase === "exercise") return mode || "exercise_intro";
    if (phase === "review") return "session_review_and_log";
    if (phase === "stopped") return "stop_session";
    return phase;
  }

  function snapshot() {
    return structuredClone({
      current_state: stateName(), state_label: stateLabelFor(stateName()), phase, mode,
      prescription_id: plan.prescription_id, prescription_version: plan.prescription_version,
      clinician_reviewed: plan.clinician_reviewed, demo_only: plan.demo_only, fast_demo_skip_opening_checks: plan.fast_demo_skip_opening_checks, program_week: plan.program_week, run_number: runNumber,
      warm_up_index: warmUpIndex, current_warm_up: currentWarmUp(), exercise_index: exerciseIndex,
      current_exercise: currentExercise(), set_index: setIndex, current_set: currentSet(), observed_count: observedCount,
      motion_awareness: motionAwareness,
      remaining_exercises: Math.max(0, plan.exercises.length - exerciseIndex), weekly_targets: plan.weekly_targets,
      rest_between_exercises_seconds: plan.rest_between_exercises_seconds,
      weekly_history: plan.weekly_history, communication_policy: communicationPolicy(plan.program_week), stop_reason: stopReason,
      outcomes, history,
    });
  }

  function getInstructions() {
    const card = taskCard();
    const action = phase === "warm_up" ? currentWarmUp() : (phase === "exercise" ? currentExercise() : null);
    const policy = communicationPolicy(plan.program_week);
    return `${getSystemInstruction()}\n\n# Controller contract\nThe controller owns state and count. Never invent progress. Call the smallest valid function silently when evidence suffices; its result triggers the next response. Continue the same conversation and say only what is missing: do not repeat the previous greeting, transition, exercise, target, or question. Never narrate system work. Healthy progress is silent; corrections stay in active_set; side switches are direct; rest/readiness repeat only for a new exercise.\n\n# Perception\nAction rules judge only the prescribed exercise. Open-world may return unknown_exercise when sustained motion is not explained by that action; this is not a classification of another exercise. Freeze counting and use one camera still to distinguish wrong activity, rest, adjustment, framing, or safety, then ask one question only if needed. A still never proves medical safety.\n\n# Vision\nThe camera and motion stream refer to the same participant. The controller supplies a readiness still before your response. Ask at most one question for facts it cannot show; never request a duplicate.\n\n# Week ${plan.program_week}\n${policy.routine_length}. ${policy.transition_rule} Expand only for questions, uncertainty/correction, changed prescription, or safety. Use relaxed conversational emphasis.\n\n# Current task\n${JSON.stringify(card)}${action ? `\n\n# Action rules\n${getActionInstruction(action)}` : ""}`;
  }

  function getTools() {
    if (phase === "completed") return structuredClone([sessionEventTool()]);
    const tools = [sessionEventTool(), visionTool(), safetyTool()];
    if (phase === "exercise" && mode === "active_set") tools.push(progressTool(), visualObservationTool());
    if (["review", "stopped"].includes(phase)) tools.push(finalizeTool());
    return structuredClone(tools);
  }

  function execute(name, args = {}) {
    if (name === "get_current_progress") return getCurrentProgress();
    if (name === "capture_vision_snapshot") return captureVision(args);
    if (name === "submit_visual_observation") return submitVisualObservation(args);
    if (name === "report_safety_stop") return safetyStop(args);
    if (name === "finalize_session") return finalizeSession(args);
    if (name === "submit_session_event") return submitEvent(args);
    return fail(`Unknown tool ${name}.`);
  }

  function getCurrentProgress() {
    if (phase !== "exercise" || mode !== "active_set") return fail("Current exercise progress is available only during active_set.");
    const target = setTarget(currentSet());
    const elapsedSeconds = Math.max(0, Number(motionAwareness.elapsed_seconds) || 0);
    return stay("Authoritative current progress returned without changing state.", false, {
      progress_query: {
        exercise_id: currentExercise()?.id,
        exercise_name: currentExercise()?.name,
        set_id: currentSet()?.set_id,
        side: currentSet()?.side || currentSet()?.direction || "not_applicable",
        unit: target.unit,
        observed_count: observedCount,
        target_count: target.value,
        remaining_count: Math.max(0, target.value - observedCount),
        elapsed_seconds: target.unit === "timed_hold" ? elapsedSeconds : null,
        target_seconds: target.unit === "timed_hold" ? target.seconds : null,
        remaining_seconds: target.unit === "timed_hold" ? Math.max(0, target.seconds - elapsedSeconds) : null,
        counting_enabled: motionAwareness.counting_enabled,
        supervisory_pause: motionAwareness.supervisory_pause,
      },
      sync_model_state: false,
    });
  }

  function submitEvent(args) {
    const event = String(args.event || "");
    if (!EVENT_NAMES.includes(event)) return fail(`Unsupported event ${event}.`);
    const before = stateName();
    switch (event) {
      case "greeting_ready":
        if (phase !== "greeting") return invalid(event);
        return plan.fast_demo_skip_opening_checks
          ? move("exercise", "exercise_intro", "fast_demo_opening_complete", before)
          : move("readiness_check", null, "greeting_ready", before);
      case "readiness_completed": {
        if (phase !== "readiness_check") return invalid(event);
        const required = ["no_warning_symptoms", "illness_cleared", "equipment_ready", "environment_clear"];
        if (required.some((key) => typeof args[key] !== "boolean")) return fail("Readiness requires four explicit boolean fields.");
        outcomes.push({ type: "readiness", ...pick(args, [...required, "issue", "note", "evidence"]) });
        if (required.some((key) => !args[key])) return safetyStop({ concern: readinessConcern(args), evidence: args.evidence || ["user_report"], note: args.note || "Readiness check failed." });
        return move("plan_briefing", null, "readiness_passed", before);
      }
      case "plan_understood":
        if (phase !== "plan_briefing") return invalid(event);
        return plan.warm_up.length
          ? move("warm_up", null, "plan_understood", before)
          : move("exercise", "exercise_intro", "prescribed_warm_up_omitted", before);
      case "warm_up_result":
        if (phase !== "warm_up") return invalid(event);
        if (!["completed", "skipped", "pause"].includes(args.status)) return fail("warm_up_result status must be completed, skipped, or pause.");
        outcomes.push({ type: "warm_up", action_id: currentWarmUp()?.id, status: args.status, note: args.note || "" });
        if (args.status === "pause") return stay("Warm-up paused.", false);
        warmUpIndex += 1;
        observedCount = 0;
        return warmUpIndex < plan.warm_up.length ? changed(before, "next_warm_up") : move("exercise", "exercise_intro", "warm_up_complete", before);
      case "prepare_exercise":
        if (phase !== "exercise" || mode !== "exercise_intro") return invalid(event);
        return move("exercise", "set_readiness", "prepare_exercise", before);
      case "skip_exercise":
        if (phase !== "exercise" || !["exercise_intro", "set_readiness", "active_set", "rest"].includes(mode)) return invalid(event);
        outcomes.push({ type: "exercise_skip", exercise_id: currentExercise()?.id, reason: args.note || "participant_requested" });
        return advanceExercise(before, "exercise_skipped");
      case "set_readiness_result":
        if (phase !== "exercise" || mode !== "set_readiness") return invalid(event);
        if (!["ready", "ready_with_reminder", "adjustment_needed"].includes(args.status)) return fail("set_readiness_result status must be ready, ready_with_reminder, or adjustment_needed; unsafe setup uses report_safety_stop.");
        outcomes.push({ type: "set_readiness", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, status: args.status, issue: args.issue || "", evidence: args.evidence || [] });
        return ["ready", "ready_with_reminder"].includes(args.status)
          ? move("exercise", "active_set", args.status === "ready_with_reminder" ? "setup_ready_with_reminder" : "setup_ready", before)
          : stay("One static setup adjustment is still needed.");
      case "motion_observation":
        if (phase !== "exercise" || mode !== "active_set") return invalid(event);
        if (!["valid", "valid_with_correction", "valid_with_recovery", "retry", "unknown", "pause"].includes(args.status)) return fail("Unsupported motion status.");
        {
          const target = setTarget(currentSet());
          const submittedCount = Number(args.count);
          const defaultIncrement = args.status === "valid" ? 1 : 0;
          const requestedIncrement = ["valid", "valid_with_correction", "valid_with_recovery"].includes(args.status)
            ? Math.max(0, Number.isFinite(submittedCount) ? submittedCount : defaultIncrement)
            : 0;
          const acceptedIncrement = Math.min(requestedIncrement, Math.max(0, target.value - observedCount));
          observedCount += acceptedIncrement;
          const motion_progress = { observed_count: observedCount, target_count: target.value, remaining_count: Math.max(0, target.value - observedCount), unit: target.unit, target_reached: observedCount === target.value };
          outcomes.push({ type: "motion", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, status: args.status, requested_count_increment: requestedIncrement, accepted_count_increment: acceptedIncrement, issue: args.issue || "", confidence: args.confidence });
          motionAwareness.last_event_at = Date.now();
          motionAwareness.last_status = args.status;
          if (acceptedIncrement > 0) {
            motionAwareness.activity = "recognized_milestone";
            motionAwareness.consecutive_errors = 0;
            motionAwareness.uncertainty_count = 0;
            motionAwareness.last_issue_code = null;
            motionAwareness.vision_escalated = false;
          }
          if (["valid_with_correction", "retry", "unknown", "pause"].includes(args.status)) return stay("Dynamic feedback remains inside the active set.", true, { motion_progress, speak: true });
          return stay("Motion evidence stored.", motion_progress.target_reached || args.status === "valid_with_recovery", { motion_progress, speak: args.status === "valid_with_recovery" });
        }
      case "perception_check_result":
        if (phase !== "exercise" || mode !== "active_set" || !motionAwareness.supervisory_pause) return invalid(event);
        if (!['safe_to_continue', 'needs_rest', 'confirmed_safety_concern'].includes(args.status)) return fail("perception_check_result status must be safe_to_continue, needs_rest, or confirmed_safety_concern.");
        outcomes.push({ type: "perception_check", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, status: args.status, evidence: args.evidence || [], note: args.note || "" });
        if (args.status === "confirmed_safety_concern") {
          return safetyStop({ concern: "fall", evidence: args.evidence || ["user_report", "motion_perception"], note: args.note || "Possible fall or instability was confirmed." });
        }
        if (args.status === "needs_rest") {
          motionAwareness.activity = "participant_resting";
          motionAwareness.awaiting_confirmation = "resume_or_skip_after_rest";
          return stay("Participant remains paused for rest.", false, { pause_motion: true, sync_model_state: true });
        }
        motionAwareness.supervisory_pause = false;
        motionAwareness.awaiting_confirmation = null;
        motionAwareness.activity = "ready_to_resume";
        motionAwareness.counting_enabled = true;
        motionAwareness.uncertainty_count = 0;
        return stay("Safety clarification resolved; motion may resume.", true, { resume_motion: true, sync_model_state: true });
      case "set_completed": {
        if (phase !== "exercise" || mode !== "active_set") return invalid(event);
        const target = setTarget(currentSet());
        const count = Math.max(0, Number(args.count) || observedCount);
        if (observedCount !== target.value || count !== target.value) return fail(`Set is not complete. Controller count is ${observedCount}/${target.value}; submitted ${count}.`);
        outcomes.push({ type: "set_complete", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, completed_count: count, note: args.note || "" });
        observedCount = 0;
        if (setIndex + 1 < (currentExercise()?.set_sequence?.length || 0)) {
          setIndex += 1;
          motionAwareness = freshMotionAwareness();
          return changed(before, "side_switch");
        }
        return move("exercise", "rest", "exercise_complete", before);
      }
      case "rest_complete":
        if (phase !== "exercise" || mode !== "rest") return invalid(event);
        return advanceAfterRest(before);
      case "extend_rest":
        if (phase !== "exercise" || mode !== "rest") return invalid(event);
        return stay("Rest extended.", false);
      case "end_early":
        if (["completed", "stopped"].includes(phase)) return invalid(event);
        stopReason = { concern: "participant_ended_early", evidence: args.evidence || ["user_report"], note: args.note || "" };
        outcomes.push({ type: "end_early", ...stopReason });
        return move("stopped", null, "participant_ended_early", before);
      case "new_session_requested":
        if (phase !== "completed") return invalid(event);
        return restartRun(before);
      default:
        return fail(`Unhandled event ${event}.`);
    }
  }

  function captureVision(args) {
    const contextKey = visionContextKey();
    const request = { purpose: args.purpose || "other", focus: String(args.focus || "current visible context"), reason: String(args.reason || "") };
    history.push({ at: Date.now(), type: "vision_requested", state: stateName(), context_key: contextKey, ...request });
    return stay("Vision snapshot requested.", false, { capture_vision: true, vision_request: request });
  }

  function submitVisualObservation(args) {
    if (phase !== "exercise" || mode !== "active_set") return fail("Visual activity observations are accepted only during active_set.");
    const activity = VISUAL_ACTIVITIES.includes(args.activity) ? args.activity : "unknown";
    const confidence = Math.max(0, Math.min(1, Number(args.confidence) || 0));
    const evidence = Array.isArray(args.evidence) ? args.evidence.slice(0, 4).map(String) : [];
    motionAwareness.visual_observation = {
      activity,
      confidence,
      person_visible: Boolean(args.person_visible),
      full_body_visible: Boolean(args.full_body_visible),
      expected_exercise_visible: Boolean(args.expected_exercise_visible),
      safety_concern_visible: Boolean(args.safety_concern_visible),
      evidence,
      at: Date.now(),
    };
    motionAwareness.evidence_sources = [...new Set([...motionAwareness.evidence_sources, "vision_snapshot"])];
    motionAwareness.hypotheses = [{ label: activity, confidence, source: "vision_snapshot" }, ...motionAwareness.hypotheses].slice(0, 4);
    outcomes.push({ type: "visual_activity_observation", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, ...motionAwareness.visual_observation });

    if (activity === "possible_fall" || activity === "unstable_recovery" || args.safety_concern_visible) {
      motionAwareness.activity = activity;
      motionAwareness.counting_enabled = false;
      motionAwareness.supervisory_pause = true;
      motionAwareness.awaiting_confirmation = "visual_safety_check";
      return stay("Visual safety hypothesis requires participant clarification.", true, {
        pause_motion: true,
        attention: {
          mode: "safety_check",
          reason: evidence.join("; ") || "The visual observation suggests a possible safety concern.",
          question: "Stop the exercise and ask whether the participant is okay and steady. Do not resume until they clearly confirm it.",
        },
        perception_update: structuredClone(motionAwareness),
      });
    }

    if (confidence < 0.6) {
      motionAwareness.activity = "visual_evidence_uncertain";
      motionAwareness.counting_enabled = false;
      motionAwareness.awaiting_confirmation = "brief_intent_check";
      return stay("The still is not reliable enough to resolve the activity.", true, {
        attention: {
          mode: "voice_check",
          question: "Ask one short question: are you ready to continue this exercise, taking a rest, or doing something else?",
          reason: evidence.join("; ") || "The visual activity confidence is below 0.6.",
        },
        perception_update: structuredClone(motionAwareness), sync_model_state: false,
      });
    }

    if (activity === "performing_expected_exercise" && args.expected_exercise_visible) {
      motionAwareness.activity = activity;
      // A still confirms visible context, not a temporal repetition or hold.
      // The detector must observe a new rep/hold start before counting resumes.
      motionAwareness.counting_enabled = false;
      motionAwareness.awaiting_confirmation = "expected_action_start";
      return stay("Vision supports the expected exercise; temporal evidence is still required before counting resumes.", false, {
        attention: { mode: "none" }, perception_update: structuredClone(motionAwareness), sync_model_state: false,
      });
    }

    motionAwareness.activity = activity;
    motionAwareness.counting_enabled = false;
    if (["left_frame", "partially_occluded", "tracking_failure"].includes(activity)) {
      return stay("Visual framing issue identified.", true, {
        attention: { mode: "coach_cue", cue: "Please return to the exercise position and keep your full body visible.", reason: activity },
        perception_update: structuredClone(motionAwareness), sync_model_state: false,
      });
    }
    if (activity === "wrong_exercise") {
      return stay("A different movement appears to be in progress.", true, {
        attention: { mode: "coach_cue", cue: `Let's return to ${currentExercise()?.name || "the prescribed movement"}.`, reason: activity },
        perception_update: structuredClone(motionAwareness), sync_model_state: false,
      });
    }
    if (["preparing_to_start", "adjusting_equipment", "resting", "inactive_but_present", "unexpected_sitting"].includes(activity)) {
      return stay("Non-exercise activity identified without a safety stop.", true, {
        attention: {
          mode: "coach_cue",
          cue: activity === "adjusting_equipment" ? "Take your time setting up; begin when ready." : "When you're ready, return to the starting position and continue.",
          reason: activity,
        },
        perception_update: structuredClone(motionAwareness), sync_model_state: false,
      });
    }
    return stay("The visual observation remains ambiguous.", true, {
      attention: { mode: "voice_check", question: "Ask whether they are resting, adjusting something, or ready to continue.", reason: evidence.join("; ") || "Visual evidence remains ambiguous." },
      perception_update: structuredClone(motionAwareness), sync_model_state: false,
    });
  }

  function recordMotionEvent(event = {}) {
    const before = stateName();
    const status = String(event.assessment?.status || event.status || "uncertain");
    const eventExerciseId = String(event.exercise?.id || event.exercise_id || "");
    const increment = Math.max(0, Number(event.observation?.valid_count_increment ?? event.valid_count_increment) || 0);
    const confidence = Number(event.observation?.confidence ?? event.confidence);
    const motionPhase = String(event.observation?.phase || event.phase || "unspecified");
    const metrics = event.observation?.metrics || event.metrics || {};
    const issueCode = String(event.assessment?.issues?.[0]?.code || event.issue_code || "");
    const issueSeverity = String(event.assessment?.issues?.[0]?.severity || event.severity || "moderate");
    const issue = String(event.assessment?.issues?.[0]?.summary || event.assessment?.summary || event.summary || "");
    const activityObservation = metrics.activity_supervisor;
    if (activityObservation && typeof activityObservation === "object") {
      motionAwareness.hypotheses = Array.isArray(activityObservation.hypotheses)
        ? activityObservation.hypotheses.slice(0, 4).map((item) => ({ ...item, source: "smpl24_window" }))
        : [];
      motionAwareness.evidence_sources = [...new Set([...motionAwareness.evidence_sources, "smpl24_window"])];
      motionAwareness.generic_features = activityObservation.features || {};
      motionAwareness.open_world_observation = {
        activity: String(activityObservation.activity || "unknown"),
        behavior_pattern: String(activityObservation.behavior_pattern || activityObservation.activity || "unknown"),
        confidence: Math.max(0, Math.min(1, Number(activityObservation.confidence) || 0)),
        unexplained_seconds: Math.max(0, Number(activityObservation.unexplained_seconds) || 0),
        candidate_persistence_seconds: Math.max(0, Number(activityObservation.candidate_persistence_seconds) || 0),
        recommended_clarification: String(activityObservation.recommended_clarification || "vision_check_activity_and_framing"),
      };
    }

    if (status === "safety_concern") {
      return safetyStop({ concern: "other", evidence: ["motion_perception"], note: issue || "Motion module reported a safety concern." });
    }

    if (phase === "exercise" && mode === "active_set" && motionPhase === "possible_fall") {
      if (!matchesCurrentAction(eventExerciseId, currentExercise()?.id)) return fail(`Motion event ${eventExerciseId || "(missing id)"} does not match current exercise ${currentExercise()?.id}.`);
      motionAwareness.activity = "possible_fall";
      motionAwareness.last_phase = motionPhase;
      motionAwareness.last_status = status;
      motionAwareness.last_issue_code = issueCode || "possible_fall";
      motionAwareness.supervisory_pause = true;
      motionAwareness.awaiting_confirmation = "possible_fall_check";
      motionAwareness.last_event_at = Date.now();
      outcomes.push({ type: "motion_safety_hypothesis", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, phase: motionPhase, issue, confidence });
      return stay("Possible fall requires immediate clarification.", true, {
        pause_motion: true,
        sync_model_state: true,
        attention: {
          mode: "safety_check",
          reason: issue || "A possible fall pattern was detected.",
          question: "Stop the exercise, ask whether the participant is okay and responsive, and tell them not to stand up quickly. Do not resume until they clearly confirm they are safe.",
        },
        perception_update: structuredClone(motionAwareness),
      });
    }

    if (phase === "exercise" && mode === "active_set" && motionAwareness.supervisory_pause) {
      return stay("Motion evidence ignored while supervisory confirmation is pending.", false, {
        pause_motion: true, sync_model_state: false, perception_update: structuredClone(motionAwareness),
      });
    }

    if (phase === "exercise" && mode === "active_set" && motionPhase === "activity_hypothesis") {
      if (!matchesCurrentAction(eventExerciseId, currentExercise()?.id)) return fail(`Motion event ${eventExerciseId || "(missing id)"} does not match current exercise ${currentExercise()?.id}.`);
      const openWorldActivity = String(activityObservation?.activity || "unexplained_activity");
      motionAwareness.last_event_at = Date.now();
      motionAwareness.last_phase = motionPhase;
      motionAwareness.last_status = status;
      motionAwareness.last_issue_code = issueCode || openWorldActivity;
      motionAwareness.activity = openWorldActivity;
      motionAwareness.counting_enabled = false;
      motionAwareness.awaiting_confirmation = "open_world_clarification";
      motionAwareness.uncertainty_count += 1;
      outcomes.push({
        type: "open_world_motion_hypothesis", exercise_id: currentExercise()?.id,
        set_id: currentSet()?.set_id, activity: openWorldActivity,
        confidence: Number(activityObservation?.confidence || confidence || 0),
        hypotheses: structuredClone(motionAwareness.hypotheses),
        features: structuredClone(motionAwareness.generic_features),
      });
      return stay("Unexplained activity suspended counting pending multimodal clarification.", true, {
        motion_progress: progressFor(setTarget(currentSet()), observedCount),
        attention: attentionForOpenWorld(openWorldActivity, issue),
        perception_update: structuredClone(motionAwareness),
        sync_model_state: false,
      });
    }

    if (phase === "exercise" && mode === "active_set" && isIntermediateMotionPhase(motionPhase)) {
      if (!matchesCurrentAction(eventExerciseId, currentExercise()?.id)) return fail(`Motion event ${eventExerciseId || "(missing id)"} does not match current exercise ${currentExercise()?.id}.`);
      motionAwareness.last_event_at = Date.now();
      motionAwareness.last_phase = motionPhase;
      motionAwareness.last_status = status;
      motionAwareness.activity = activityFromPhase(motionPhase);
      motionAwareness.counting_enabled = true;
      motionAwareness.awaiting_confirmation = null;
      motionAwareness.vision_escalated = false;
      if (Number.isFinite(Number(metrics.elapsed_seconds))) motionAwareness.elapsed_seconds = Number(metrics.elapsed_seconds);
      outcomes.push({ type: "motion_intermediate", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, phase: motionPhase, elapsed_seconds: motionAwareness.elapsed_seconds, confidence });
      return stay("Intermediate motion state updated.", false, {
        motion_progress: progressFor(setTarget(currentSet()), observedCount),
        perception_update: structuredClone(motionAwareness),
        notify_model: motionPhase === "hold_started" || motionPhase === "hold_progress",
        sync_model_state: false,
      });
    }

    if (phase === "warm_up") {
      const action = currentWarmUp();
      if (!matchesCurrentAction(eventExerciseId, action?.id)) return fail(`Motion event ${eventExerciseId || "(missing id)"} does not match current warm-up ${action?.id}.`);
      const target = warmUpTarget(action);
      const acceptedIncrement = status === "correct" ? Math.min(increment, Math.max(0, target.value - observedCount)) : 0;
      observedCount += acceptedIncrement;
      const motion_progress = progressFor(target, observedCount);
      outcomes.push({ type: "warm_up_motion", action_id: action?.id, status, requested_count_increment: increment, accepted_count_increment: acceptedIncrement, issue, confidence });

      if (motion_progress.target_reached) {
        outcomes.push({ type: "warm_up", action_id: action?.id, status: "completed", note: "Completed from motion count." });
        warmUpIndex += 1;
        observedCount = 0;
        return warmUpIndex < plan.warm_up.length
          ? changed(before, "warm_up_motion_target_reached", { motion_progress })
          : move("exercise", "exercise_intro", "warm_up_motion_complete", before, { motion_progress });
      }
      const needsResponse = status !== "correct";
      return stay(needsResponse ? "Warm-up motion needs attention." : "Warm-up count updated.", needsResponse, { motion_progress, speak: needsResponse });
    }

    if (phase === "exercise" && mode === "active_set") {
      if (!matchesCurrentAction(eventExerciseId, currentExercise()?.id)) return fail(`Motion event ${eventExerciseId || "(missing id)"} does not match current exercise ${currentExercise()?.id}.`);
      const mappedStatus = ({ correct: "valid", needs_correction: "valid_with_correction", uncertain: "unknown" })[status] || "unknown";
      if (status === "correct" && increment > 0 && !motionAwareness.counting_enabled) {
        return stay("Completion was not counted because a new expected-action start has not been observed.", false, {
          motion_progress: progressFor(setTarget(currentSet()), observedCount),
          attention: { mode: "none" }, perception_update: structuredClone(motionAwareness), sync_model_state: false,
        });
      }
      const pendingCorrection = status === "correct" && increment > 0 ? motionAwareness.pending_correction : null;
      if (status === "needs_correction") {
        motionAwareness.consecutive_errors = motionAwareness.last_issue_code === (issueCode || "movement_quality")
          ? motionAwareness.consecutive_errors + 1
          : 1;
        motionAwareness.uncertainty_count = 0;
        motionAwareness.last_issue_code = issueCode || "movement_quality";
        motionAwareness.activity = motionPhase === "hold_interrupted" ? "hold_interrupted" : "incorrect_attempt";
        motionAwareness.pending_correction = { issue_code: motionAwareness.last_issue_code, issued_after_attempt: Number(event.exercise?.rep_index || 0), issue };
        motionAwareness.last_correction_outcome = "pending";
      } else if (status === "uncertain") {
        motionAwareness.uncertainty_count += 1;
        motionAwareness.activity = ["tracking_lost", "stream_stalled", "no_recognized_activity", "activity_hypothesis"].includes(motionPhase) ? motionPhase : "uncertain";
        motionAwareness.counting_enabled = false;
        motionAwareness.awaiting_confirmation = "perception_clarification";
      }
      const result = submitEvent({ event: "motion_observation", status: mappedStatus, count: increment, confidence, issue });
      if (pendingCorrection) {
        motionAwareness.pending_correction = null;
        motionAwareness.last_correction_outcome = "improved_on_next_valid_attempt";
      }
      const attention = pendingCorrection && !result.motion_progress?.target_reached
        ? { mode: "recovery_ack", cue: `The next valid attempt improved after the ${pendingCorrection.issue_code} correction.` }
        : attentionForMotion({ status, motionPhase, issueCode, issue, issueSeverity });
      return { ...result, attention, perception_update: structuredClone(motionAwareness), sync_model_state: false };
    }

    return fail(`Motion counting is unavailable while the cursor is ${stateName()}.`);
  }

  function attentionForMotion({ status, motionPhase, issueCode, issue, issueSeverity }) {
    if (status === "needs_correction") {
      if ((motionAwareness.consecutive_errors >= 2 || ["high", "critical"].includes(issueSeverity)) && !motionAwareness.vision_escalated) {
        motionAwareness.vision_escalated = true;
        return {
          mode: "vision",
          purpose: "motion_uncertainty",
          focus: `Current ${currentExercise()?.name || "exercise"} posture, support use, body visibility, and the suspected ${issueCode || "movement error"}`,
          reason: `The same set has produced ${motionAwareness.consecutive_errors} consecutive invalid or interrupted attempts.`,
          cue: issue,
        };
      }
      if (motionAwareness.consecutive_errors >= 3) {
        return {
          mode: "voice_check",
          question: "Pause briefly and ask whether the participant is comfortable, understands the correction, and wants to retry or skip.",
          reason: "Repeated invalid attempts persisted after corrective evidence.",
          cue: issue,
        };
      }
      return { mode: "coach_cue", cue: issue || "Give one concise action-specific correction.", reason: motionPhase };
    }
    if (status === "uncertain") {
      if (!motionAwareness.vision_escalated) {
        motionAwareness.vision_escalated = true;
        return {
          mode: "vision",
          purpose: "motion_uncertainty",
          focus: ["tracking_lost", "tracking_unreliable", "frame_loss", "stream_gap", "stream_stalled"].includes(motionPhase)
            ? "Whether the full body and support surface are visible and unobstructed"
            : `Whether the participant is still attempting ${currentExercise()?.name || "the prescribed exercise"}, has stopped, or is doing another activity`,
          reason: issue || "The joint stream cannot confidently explain the current activity.",
        };
      }
      return {
        mode: "voice_check",
        question: "Ask one short question to confirm whether the participant is still exercising, needs help, or wants to pause.",
        reason: issue || "Motion uncertainty remained after a visual escalation.",
      };
    }
    return { mode: "none" };
  }

  function attentionForOpenWorld(activity, issue) {
    if (motionAwareness.vision_escalated) {
      return {
        mode: "voice_check",
        question: "Ask one short question to determine whether the participant is doing another activity, resting, adjusting equipment, or ready to resume the prescribed exercise.",
        reason: issue || `The ${activity} hypothesis persisted after visual clarification.`,
      };
    }
    motionAwareness.vision_escalated = true;
    const focusByActivity = {
      unexpected_locomotion: `Whether the participant left the ${currentExercise()?.name || "exercise"} position, is changing equipment, or began a different activity`,
      unexplained_repetitive_motion: `Whether the visible repeated movement is ${currentExercise()?.name || "the prescribed exercise"}, a different exercise, or an equipment adjustment`,
      unstable_recovery: "Full-body posture, support use, foot placement, and any visible loss of balance",
      unexpected_sitting: "Whether the participant intentionally sat to rest, lost balance, or moved out of the intended starting posture",
      inactive_present: `Whether the participant is resting, preparing, or waiting to resume ${currentExercise()?.name || "the exercise"}`,
      unknown_exercise: `Whether the participant is attempting ${currentExercise()?.name || "the prescribed exercise"}, doing another activity, resting, or adjusting equipment`,
    };
    return {
      mode: "vision",
      purpose: activity === "unstable_recovery" ? "safety_clarification" : "motion_uncertainty",
      focus: focusByActivity[activity] || `Current visible activity, full-body framing, support, and whether ${currentExercise()?.name || "the prescribed exercise"} is being attempted`,
      reason: issue || `The temporal joint stream was persistently classified as ${activity}; counting is paused until it is clarified.`,
    };
  }

  function safetyStop(args) {
    const before = stateName();
    const concern = SAFETY_CONCERNS.includes(args.concern) ? args.concern : "other";
    stopReason = { concern, evidence: Array.isArray(args.evidence) ? args.evidence : ["user_report"], note: String(args.note || "") };
    outcomes.push({ type: "safety_stop", ...stopReason });
    return move("stopped", null, `safety_${concern}`, before);
  }

  function finalizeSession(args) {
    if (!["review", "stopped"].includes(phase)) return fail("finalize_session is allowed only in review or stopped.");
    const before = stateName();
    outcomes.push({ type: "session_review", perceived_difficulty: args.perceived_difficulty || "not_reported", issues_for_pt: args.issues_for_pt || [], diary_note: args.diary_note || "", disposition: args.disposition || "none", weekly_count_effect: weeklyEffect() });
    return move("completed", null, "session_finalized", before, { finalized: true });
  }

  function advanceAfterRest(before) {
    return advanceExercise(before, "next_exercise");
  }

  function advanceExercise(before, reason) {
    exerciseIndex += 1;
    setIndex = 0;
    observedCount = 0;
    return exerciseIndex < plan.exercises.length ? move("exercise", "exercise_intro", reason, before) : move("review", null, "all_exercises_complete", before);
  }

  function move(nextPhase, nextMode, reason, before = stateName(), extra = {}) {
    phase = nextPhase;
    mode = nextMode;
    if (nextPhase === "exercise" && nextMode === "active_set") motionAwareness = freshMotionAwareness();
    return changed(before, reason, extra);
  }

  function changed(before, reason, extra = {}) {
    const after = stateName();
    history.push({ at: Date.now(), type: "cursor", from: before, to: after, reason });
    return { ok: true, state_changed: before !== after, previous_state: before, current_state: after, reason, snapshot: snapshot(), continue_response: true, ...extra };
  }

  function stay(message, continueResponse = true, extra = {}) {
    return { ok: true, state_changed: false, current_state: stateName(), message, snapshot: snapshot(), continue_response: continueResponse, ...extra };
  }

  function fail(error) {
    return { ok: false, state_changed: false, current_state: stateName(), error, snapshot: snapshot(), continue_response: true };
  }

  function invalid(event) { return fail(`${event} is invalid while the cursor is ${stateName()}.`); }

  function restartRun(before) {
    runNumber += 1;
    phase = "greeting"; mode = null; warmUpIndex = 0; exerciseIndex = 0; setIndex = 0; observedCount = 0; stopReason = null;
    motionAwareness = freshMotionAwareness();
    outcomes.splice(0); history.splice(0);
    history.push({ at: Date.now(), type: "cursor", from: before, to: stateName(), reason: "new_session_requested" });
    return { ok: true, state_changed: true, previous_state: before, current_state: stateName(), reason: "new_session_requested", snapshot: snapshot(), continue_response: true };
  }

  function setPrescription(next) {
    if (!['greeting', 'readiness_check', 'plan_briefing'].includes(stateName())) return fail("Prescription can only be replaced before warm-up.");
    try {
      plan = normalizePrescription(next); warmUpIndex = exerciseIndex = setIndex = observedCount = 0;
      history.push({ at: Date.now(), type: "prescription", prescription_id: plan.prescription_id });
      return stay("Prescription loaded.", false, { prescription_loaded: true });
    } catch (error) { return fail(error.message); }
  }

  function autoRouteFromRest() {
    return phase === "exercise" && mode === "rest" ? submitEvent({ event: "rest_complete" }) : fail("Cursor is not resting.");
  }

  function visionContextKey() {
    if (phase === "readiness_check") return `run:${runNumber}:readiness`;
    if (phase === "exercise") return `run:${runNumber}:exercise:${currentExercise()?.id || "none"}:set:${currentSet()?.set_id || setIndex}`;
    if (phase === "warm_up") return `run:${runNumber}:warm_up:${currentWarmUp()?.id || warmUpIndex}`;
    return `run:${runNumber}:state:${stateName()}`;
  }

  function visionContext() {
    const contextKey = visionContextKey();
    const latest = [...history].reverse().find((item) => item.type === "vision_requested" && item.context_key === contextKey);
    return {
      context_key: contextKey,
      requested_for_context: Boolean(latest),
      last_purpose: latest?.purpose || null,
    };
  }

  function taskCard() {
    const base = { state: stateName(), phase, mode, prescription: { id: plan.prescription_id, version: plan.prescription_version, week: plan.program_week } };
    if (phase === "greeting") return { ...base, objective: plan.fast_demo_skip_opening_checks
      ? "Speak first: greet naturally as the participant's Otago coach in one short sentence. Speak only as a live coach addressing the participant. Then silently submit greeting_ready in the same response so the controller can introduce the actual first prescribed exercise without waiting for another participant utterance."
      : `Speak before using a function. Say hello and ${plan.program_week > 1 ? `welcome the participant back to week ${plan.program_week}` : "welcome the participant to week 1"} of Otago training. Say you will follow the PT-prescribed plan and keep guidance brief, then ask readiness for a quick safety check. [SESSION_START] opens the conversation and is never readiness consent; call greeting_ready only after the participant replies affirmatively.`, expected_events: ["greeting_ready"] };
    if (phase === "readiness_check") return { ...base, objective: "Always begin this readiness check with exactly one silent environment_readiness photo when vision.requested_for_context is false. Use it for chair, equipment, floor space, lighting, and framing; then ask only the minimum symptom, illness-clearance, occluded, or uncertain question. If the participant says they are ready but the image shows a noncritical visible mismatch, give one practical reminder, include it as issue/evidence, and allow readiness_completed with true fields. A clear immediate hazard uses report_safety_stop. Never infer symptoms or illness clearance from vision.", required_setup: readinessRequirements(plan), vision: visionContext(), expected_events: ["readiness_completed", "end_early"] };
    if (phase === "plan_briefing") return { ...base, objective: plan.warm_up.length
      ? "Brief the 52-week PT plan and today's queue, then confirm understanding. Do not begin or cue the first warm-up action until plan_understood is returned."
      : `Give a concise progress-oriented briefing for week ${plan.program_week} of ${plan.program_duration_weeks}. This intentionally bounded program has exactly today's two prescribed actions and no additional exercise sequence: five knee bends with two-hand chair support, then a ten-second one-leg stand on each side with one-hand support. The participant has completed ${plan.weekly_history.balance_days_completed || 0} balance days toward the weekly minimum of ${plan.weekly_targets.balance_days_minimum || 3}; explain naturally that completing today's prescribed sets can count as another balance day. Confirm that this plan sounds okay before introducing the first exercise. Do not start either movement yet.`, weekly_targets: plan.weekly_targets, weekly_history: plan.weekly_history, today: todayActionNames(plan), expected_events: ["plan_understood", "end_early"] };
    if (phase === "warm_up") return { ...base, objective: "Give the current dose and one cue. Motion counts arrive through the controller; use warm_up_result only for an explicit participant-reported completion, skip, or pause.", item_number: warmUpIndex + 1, item_count: plan.warm_up.length, action: currentWarmUp(), target: warmUpTarget(currentWarmUp()), observed_count: observedCount, expected_events: ["warm_up_result", "end_early"] };
    if (phase === "exercise") {
      const exercise = currentExercise();
      const target = setTarget(currentSet());
      const common = { ...base, exercise_number: exerciseIndex + 1, exercise_count: plan.exercises.length, exercise: exercise ? { id: exercise.id, name: exercise.name, category: exercise.category } : null, set_number: setIndex + 1, set_count: exercise?.set_sequence?.length || 0, set: currentSet(), target, observed_count: observedCount, motion_awareness: motionAwareness };
      if (mode === "exercise_intro") return { ...common, objective: "Continue naturally from the previous stage. State whether this is the first or second exercise, name its prescribed target and support level, and ask whether the participant is ready to set up or wants to skip it. Do not repeat the session greeting or the complete plan.", expected_events: ["prepare_exercise", "skip_exercise", "end_early"] };
      if (mode === "set_readiness") return { ...common, objective: "Always begin this new exercise's static readiness check with exactly one silent exercise_setup photo when vision.requested_for_context is false. Check starting side, posture, chair/support, visible weight placement, space, and framing. This is not dynamic form assessment. If the participant says they are ready but the image shows a noncritical mismatch, give one practical reminder and submit ready_with_reminder so exercise continues. Use adjustment_needed only when they choose to adjust first; a clear immediate hazard uses report_safety_stop.", vision: visionContext(), latest_issue: latestIssue(outcomes, exercise?.id), expected_events: ["set_readiness_result", "skip_exercise", "end_early"] };
      if (mode === "active_set" && motionAwareness.supervisory_pause) return { ...common, objective: "The local safety supervisor has frozen motion counting. Do not coach another repetition. Resolve the pending clarification with the minimum necessary question. For a possible fall, first establish that the participant is responsive and okay; tell them not to stand quickly. Submit perception_check_result with safe_to_continue only after an explicit reassuring response, needs_rest when they want to remain paused, or confirmed_safety_concern when they fell, are injured, are unstable, or need help. Never infer safety from silence or a single still image.", vision: visionContext(), expected_events: ["perception_check_result", "skip_exercise", "end_early"] };
      if (mode === "active_set") return { ...common, objective: "Give the start cue. Perception tracks intermediate activity, milestones, repeated errors, uncertainty, open-world activity, and safety. Never invent motion facts; healthy progress is silent. MOTION_PROGRESS is sensor context, not participant speech. If asked about completed/remaining reps or hold seconds, silently call get_current_progress and use its authoritative result. Give one concise cue for an isolated error. An open-world hypothesis freezes counting. When vision is requested, silently capture and submit one visual observation. A still cannot resume counting; require a new temporal rep_started or hold_started. Possible fall freezes motion pending explicit clarification; confirmed fall stops the session. Submit set_completed only at the target. Switch sides directly without rest/readiness.", vision: visionContext(), expected_events: ["motion_observation", "set_completed", "skip_exercise", "end_early"] };
      return { ...common, rest_seconds: plan.rest_between_exercises_seconds, objective: `This is the break between exercises, never between left/right sets. Tell the participant to take a ${plan.rest_between_exercises_seconds}-second breather. The local timer will advance automatically; do not repeatedly ask whether they are ready.`, expected_events: ["rest_complete", "extend_rest", "skip_exercise", "end_early"] };
    }
    if (phase === "review") return { ...base, objective: "Summarize only recorded outcomes and weekly count effect, ask one difficulty question if needed, then finalize.", session_results: summarizeOutcomes(outcomes), weekly_count_effect: weeklyEffect(), expected_function: "finalize_session" };
    if (phase === "stopped") return { ...base, objective: "Give the appropriate calm safety/early-end disposition and finalize; do not resume exercise.", stop_reason: stopReason, expected_function: "finalize_session" };
    return { ...base, objective: "Give one brief closing. Start again only after an explicit request.", expected_events: ["new_session_requested"] };
  }

  function weeklyEffect() {
    const completed = new Set(outcomes.filter((item) => item.type === "set_complete").map((item) => `${item.exercise_id}:${item.set_id}`));
    const prescribedSets = (category) => plan.exercises
      .filter((item) => item.category === category)
      .flatMap((item) => item.set_sequence.map((setSpec) => `${item.id}:${setSpec.set_id}`));
    const strength = prescribedSets("strength");
    const balance = prescribedSets("balance");
    const strengthDay = strength.length > 0 && strength.every((id) => completed.has(id));
    const balanceDay = balance.length > 0 && balance.every((id) => completed.has(id));
    return { strength_day_completed: strengthDay, balance_day_completed: balanceDay, strength_days_after_session: plan.weekly_history.strength_days_completed + Number(strengthDay), balance_days_after_session: plan.weekly_history.balance_days_completed + Number(balanceDay), walking_days_unchanged: plan.weekly_history.walking_days_completed };
  }

  return { snapshot, getInstructions, getTools, execute, recordMotionEvent, setPrescription, autoRouteFromRest };
}

function freshMotionAwareness() {
  return {
    activity: "waiting_for_motion",
    last_phase: null,
    last_status: null,
    elapsed_seconds: 0,
    consecutive_errors: 0,
    uncertainty_count: 0,
    last_issue_code: null,
    vision_escalated: false,
    supervisory_pause: false,
    awaiting_confirmation: null,
    pending_correction: null,
    last_correction_outcome: null,
    last_event_at: null,
    counting_enabled: true,
    hypotheses: [],
    evidence_sources: [],
    generic_features: {},
    visual_observation: null,
    open_world_observation: null,
  };
}

function isIntermediateMotionPhase(phase) {
  return ["rep_started", "rep_progress", "hold_started", "hold_progress"].includes(phase);
}

function activityFromPhase(phase) {
  if (phase.startsWith("hold_")) return "holding";
  if (phase.startsWith("rep_")) return "repetition_in_progress";
  return "active";
}

function sessionEventTool() {
  return tool("submit_session_event", "Submit one ordinary participant/session event to the controller. The controller validates it against the current task card.", {
    event: enumeration(EVENT_NAMES, "Smallest supported event evidenced now."), status: enumeration([...STATUSES, "ready_with_reminder", "adjustment_needed"], "Outcome when the event needs one."),
    count: integer("Observed/completed reps, steps, trials, or 1 for a timed hold."), issue: string("One factual issue."), confidence: number("Evidence confidence 0-1."), evidence: strings("Evidence sources."), note: string("Brief factual note or skip reason."),
    no_warning_symptoms: bool("Readiness only."), illness_cleared: bool("Readiness only."), equipment_ready: bool("Readiness only."), environment_clear: bool("Readiness only."),
  }, ["event"]);
}
function visionTool() {
  return tool("capture_vision_snapshot", "Proactively and silently capture one still before asking when it can replace multiple visible-fact questions or a setup checklist. Do not repeat it for the same context unless a new visible uncertainty arises.", {
    purpose: enumeration(["environment_readiness", "equipment_check", "exercise_setup", "form_clarification", "motion_uncertainty", "safety_clarification", "framing_check", "other"], "Visual purpose."),
    focus: string("Concrete visible evidence to inspect."), reason: string("Why it changes the next action."),
  }, ["purpose", "focus"]);
}
function progressTool() {
  return tool("get_current_progress", "Read the controller's authoritative current repetitions or timed-hold progress. Always call this when the participant asks how much is complete or remains; never estimate from conversational memory.", {}, []);
}
function visualObservationTool() {
  return tool("submit_visual_observation", "Return one structured interpretation of an agent-requested still. This is supporting evidence, not a diagnosis and not proof of safety.", {
    activity: enumeration(VISUAL_ACTIVITIES, "Most likely visible activity."),
    confidence: number("Confidence from 0 to 1."),
    person_visible: bool("Whether the participant is visible."),
    full_body_visible: bool("Whether the participant and support area are fully visible."),
    expected_exercise_visible: bool("Whether the prescribed exercise is visibly being attempted."),
    safety_concern_visible: bool("Whether the still suggests a possible safety concern requiring verbal confirmation."),
    evidence: strings("Up to four concise visible facts; do not infer symptoms."),
  }, ["activity", "confidence", "person_visible", "full_body_visible", "expected_exercise_visible", "safety_concern_visible", "evidence"]);
}
function safetyTool() {
  return tool("report_safety_stop", "Immediately lock the controller in stopped mode for a safety concern.", {
    concern: enumeration(SAFETY_CONCERNS, "Primary concern."), evidence: strings("Evidence sources."), note: string("Brief factual note."),
  }, ["concern", "evidence"]);
}
function finalizeTool() {
  return tool("finalize_session", "Finalize only from review or stopped mode and persist the disposition.", {
    perceived_difficulty: enumeration(["easy", "appropriate", "hard", "not_reported"], "Participant report."), issues_for_pt: strings("Unresolved factual issues."), diary_note: string("Optional deidentified note."),
    disposition: enumeration(["none", "pt_follow_up", "healthcare_follow_up", "urgent_or_emergency_help", "participant_ended_early"], "Stop/follow-up disposition."),
  }, []);
}

function stateLabelFor(state) {
  return ({ greeting: "Greeting", readiness_check: "Readiness check", plan_briefing: "Plan briefing", warm_up_sequence: "Warm-up sequence", exercise_intro: "Exercise introduction", set_readiness: "Set readiness", active_set: "Active set", rest: "15-second rest", session_review_and_log: "Session review", stop_session: "Stopped", completed: "Completed" })[state] || state;
}
function setTarget(setSpec = {}) {
  if (setSpec.repetitions) return { unit: "repetitions", value: Number(setSpec.repetitions) };
  if (setSpec.steps) return { unit: "steps", value: Number(setSpec.steps) };
  if (setSpec.patterns) return { unit: "patterns", value: Number(setSpec.patterns) };
  if (setSpec.hold_seconds) return { unit: "timed_hold", value: 1, seconds: Number(setSpec.hold_seconds) };
  return { unit: "trial", value: 1 };
}
function warmUpTarget(action = {}) {
  if (action.repetitions_each_side) return { unit: "bilateral_cycles", value: Number(action.repetitions_each_side) };
  if (action.repetitions) return { unit: "repetitions", value: Number(action.repetitions) };
  if (action.hold_seconds) return { unit: "timed_hold", value: 1, seconds: Number(action.hold_seconds) };
  return { unit: "trial", value: 1 };
}
function progressFor(target, observedCount) {
  return { observed_count: observedCount, target_count: target.value, remaining_count: Math.max(0, target.value - observedCount), unit: target.unit, target_reached: observedCount === target.value };
}
function matchesCurrentAction(eventId, currentId) {
  return ["current_action", "current_exercise", "current_warm_up"].includes(eventId) || eventId === currentId;
}
function todayActionNames(plan) { return { warm_up: plan.warm_up.map((item) => item.name), strength: plan.exercises.filter((item) => item.category === "strength").map((item) => item.name), balance: plan.exercises.filter((item) => item.category === "balance").map((item) => item.name) }; }
function readinessRequirements(plan) {
  const supports = new Set(); const weights = new Set();
  for (const item of plan.warm_up) if (item.support) supports.add(item.support);
  for (const exercise of plan.exercises) for (const setSpec of exercise.set_sequence || []) { if (setSpec.support) supports.add(setSpec.support); if (Number(setSpec.ankle_weight_kg) > 0) weights.add(Number(setSpec.ankle_weight_kg)); }
  return { supports: [...supports], ankle_weights_kg: [...weights], clear_space: true, framing: "current action and support visible" };
}
function latestIssue(outcomes, exerciseId) { return [...outcomes].reverse().find((item) => item.exercise_id === exerciseId && item.issue)?.issue || null; }
function summarizeOutcomes(items) {
  return { warm_up: items.filter((item) => item.type === "warm_up").map((item) => pick(item, ["action_id", "status"])), completed_sets: items.filter((item) => item.type === "set_complete").map((item) => pick(item, ["exercise_id", "set_id", "completed_count"])), skips: items.filter((item) => item.type === "exercise_skip").map((item) => pick(item, ["exercise_id", "reason"])), issues: items.filter((item) => item.issue).map((item) => pick(item, ["exercise_id", "set_id", "status", "issue"])) };
}
function readinessConcern(args) { if (!args.no_warning_symptoms) return "other"; if (!args.illness_cleared) return "other"; if (!args.equipment_ready || !args.environment_clear) return "unsafe_setup"; return "other"; }
function communicationPolicy(week) {
  if (week <= 2) return { phase: "early familiarization", default_detail: "2–3 short sentences for a new action", routine_length: "Use two or three short sentences for a new action", transition_rule: "Name action, target, support, and one cue." };
  if (week <= 6) return { phase: "skill consolidation", default_detail: "1–2 short sentences", routine_length: "Use one or two short sentences", transition_rule: "Name action and target, then one cue." };
  return { phase: "maintenance", default_detail: "one direct instruction", routine_length: "Use one direct instruction, normally no more than about 12 spoken words", transition_rule: "State only the next side/task and target for familiar transitions." };
}
function normalizePrescription(value) {
  if (!value || typeof value !== "object") throw new Error("Prescription must be an object.");
  const plan = structuredClone(value);
  plan.prescription_id = String(value.prescription_id || "unnamed-prescription"); plan.prescription_version = String(value.prescription_version || "unversioned");
  plan.clinician_reviewed = Boolean(value.clinician_reviewed); plan.demo_only = Boolean(value.demo_only); plan.fast_demo_skip_opening_checks = Boolean(value.fast_demo_skip_opening_checks); plan.program_week = Number(value.program_week || 1); plan.program_duration_weeks = Number(value.program_duration_weeks || 52); plan.allow_warm_up_omission_for_technical_demo = Boolean(value.allow_warm_up_omission_for_technical_demo);
  plan.weekly_targets = value.weekly_targets || {}; plan.weekly_history = { strength_days_completed: 0, balance_days_completed: 0, walking_days_completed: 0, ...(value.weekly_history || {}) };
  plan.rest_between_exercises_seconds = Math.max(0, Number(value.rest_between_exercises_seconds ?? 15));
  plan.walking_plan = value.walking_plan || null;
  plan.warm_up = Array.isArray(value.warm_up) ? value.warm_up.map((item, index) => validateAction(item, index, "warm_up")) : [];
  plan.exercises = Array.isArray(value.exercises) ? value.exercises.map((item, index) => validateAction(item, index, item.category)) : [];
  if (!plan.exercises.length) throw new Error("Prescription requires an exercise queue.");
  if (!plan.warm_up.length && !(plan.demo_only && plan.allow_warm_up_omission_for_technical_demo)) throw new Error("Prescription requires a warm-up queue; only an explicitly flagged technical demo may omit it.");
  for (const exercise of plan.exercises) if (!Array.isArray(exercise.set_sequence) || !exercise.set_sequence.length) throw new Error(`Exercise ${exercise.id} requires set_sequence.`);
  return plan;
}
function validateAction(action, index, category) {
  if (!action?.id || !action?.name) throw new Error(`Action ${index + 1} requires id and name.`);
  if (!listSupportedActionIds().includes(action.id)) throw new Error(`Unsupported instruction id: ${action.id}.`);
  if (!["warm_up", "strength", "balance"].includes(category)) throw new Error(`Action ${action.id} has invalid category.`);
  return structuredClone({ ...action, category });
}
function tool(name, description, properties, required = []) { return { type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false } }; }
function string(description) { return { type: "string", description }; }
function bool(description) { return { type: "boolean", description }; }
function integer(description) { return { type: "integer", minimum: 0, description }; }
function number(description) { return { type: "number", minimum: 0, maximum: 1, description }; }
function enumeration(values, description) { return { type: "string", enum: values, description }; }
function strings(description) { return { type: "array", items: { type: "string" }, description }; }
function pick(source, keys) { return Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, structuredClone(source[key])])); }
