import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getActionInstruction, getSystemInstruction, listSupportedActionIds } from "./instruction-library.mjs";

const rootDir = dirname(fileURLToPath(import.meta.url));
export const INITIAL_OTAGO_STATE = "greeting";
export const DEMO_PRESCRIPTION = Object.freeze(JSON.parse(readFileSync(resolve(rootDir, "prescriptions/demo-prescription.json"), "utf8")));
const symptoms = ["pain", "dizziness", "chest_pain", "severe_shortness_of_breath", "fall", "instability", "fainting", "other"];

const STATES = {
  greeting: state("Greeting", "Welcome the participant and establish the coach's limited role.", [
    "Say this assistant guides an already prescribed Otago home session and does not replace the physical therapist.",
    "Keep the opening to two short sentences, then ask whether the participant is ready for a safety check.",
    "After a clear yes, make complete_greeting as the only output. Do not acknowledge the yes aloud; the controller will create the readiness-check turn.",
  ], [tool("complete_greeting", "Record agreement to begin the readiness check.", { ready_for_check: bool("Clear agreement.") }, ["ready_for_check"])]),

  readiness_check: state("Readiness check", "Check symptoms, illness, equipment/support, and environment.", [
    "When visible readiness facts are missing or uncertain, use capture_vision_snapshot to inspect the chair, prescribed equipment/support, clear floor space, lighting, and camera framing instead of asking the participant to describe what is already visible.",
    "Vision cannot establish pain, dizziness, illness, PT clearance, chair stability, actual weight, or hidden hazards. Ask one short question at a time only for those user-report fields or any visually uncertain requirement.",
    "Do not diagnose. Record any warning symptom, uncleared illness, missing support, or unsafe environment.",
    "Call record_readiness only after all fields are explicit. When they become explicit, the function call must be the first and only output—no spoken acknowledgement or promise to wrap up the check. Include vision_snapshot in the note when visible evidence was used; the controller decides the next state.",
  ], [tool("record_readiness", "Record readiness. Safe input advances; any unsafe input goes to stop_session.", {
    no_warning_symptoms: bool("No pain, dizziness, chest pain, severe shortness of breath, fall, or instability."),
    illness_cleared: bool("No relevant interruption, or PT-cleared resumption."),
    equipment_ready: bool("Prescribed equipment, support, and aid are ready."),
    environment_clear: bool("Movement area is clear and appropriately lit."),
    concern: enumeration(["none", ...symptoms, "illness_not_cleared", "missing_equipment", "unsafe_environment"], "Most important concern."),
    note: string("Short factual note."),
  }, ["no_warning_symptoms", "illness_cleared", "equipment_ready", "environment_clear", "concern"])]),

  plan_briefing: state("Plan briefing", "Explain the current PT-authored prescription without changing it.", [
    "Use runtime data: version, week, today's warm-up/strength/balance list, and exact weekly counts.",
    "Briefly explain: the program lasts 52 weeks; strength targets 3 days/week with a rest day between; balance targets at least 3 days/week and may be daily when prescribed; warm-up precedes either.",
    "Individual strength/balance exercises may be skipped and recorded; never substitute a new movement.",
    "Walking is separate from this supervised queue. Stair walking is advanced and only when explicitly prescribed with required handrail/supervision.",
    "After the participant confirms understanding, make confirm_plan_briefing as the only output. Do not say you are moving into warm-up; the controller will create that turn.",
  ], [tool("confirm_plan_briefing", "Confirm the loaded plan and enter warm-up.", { understood: bool("Plan understood.") }, ["understood"])]),

  warm_up_sequence: state("Warm-up sequence", "Complete breathing and prescribed flexibility items in order.", [
    "Introduce only the current warm-up item and its exact repetitions, posture, motion definition, and support.",
    "Give one concise cue at a time. Never add an item or invent a missing definition.",
    "On a clear report that the item is complete, skipped, paused, or stopped: make record_warm_up_item as the only output of that response. Do not speak before or after the function call; the controller will create the next voice turn.",
  ], [
    tool("record_warm_up_item", "Record the current warm-up item and advance within the sequence.", {
      outcome: enumeration(["completed", "skipped", "pause", "stop"], "Item outcome."), note: string("Short factual note."),
    }, ["outcome"]), safetyTool(),
  ]),

  exercise_intro: state("Exercise introduction", "Introduce exactly the current prescribed strength or balance exercise.", [
    "State exercise name and current set: side/direction, weight, repetitions/time/steps/patterns, and support.",
    "Give the highest-priority action cue from instructions/, then ask whether to set up or skip.",
    "Never change dose or support. On a clear skip or setup agreement, call skip_current_exercise or begin_form_check as the first and only output. Do not say that you will handle, update, or check anything first.",
  ], [
    tool("begin_form_check", "Begin setup validation.", { ready: bool("Participant agreed to prepare.") }, ["ready"]),
    tool("skip_current_exercise", "Record an omission and advance.", { reason: string("Participant's reason; do not pressure.") }, ["reason"]),
    safetyTool(),
  ]),

  form_check: state("Form and setup check", "Confirm posture, equipment, support, and sensor visibility.", [
    "Check the exact current set and current action instruction. Ask only for missing setup information.",
    "When a current image would resolve a setup question, use capture_vision_snapshot to inspect posture, chair/support placement, visible weight attachment, foot/hand position, and whether required body parts are in frame.",
    "Treat vision conservatively: visible proximity is not proof of stable support or secure fastening, and an image cannot verify the actual resistance/weight. Ask only when a required condition is occluded or uncertain.",
    "Immediately ask the one missing setup question or, if the participant has already confirmed the prescribed setup, record it and begin the set. Never say you are checking/logging and then remain silent.",
    "Use motion for observable evidence but never claim a hidden hand, foot, weight, or object is visible.",
    "Call record_form_check: ready starts; correction_needed stays; unsafe_setup or symptom_detected stops. When the input is ready, use only the function call; the controller creates the direct start cue.",
  ], [
    tool("record_form_check", "Record setup and route to active set, correction, or stop.", {
      outcome: enumeration(["ready", "correction_needed", "unsafe_setup", "symptom_detected"], "Setup result."),
      issue: string("One observable issue or empty string."), evidence: strings("Evidence sources."),
    }, ["outcome", "issue", "evidence"]),
    tool("skip_current_exercise", "Record a participant-requested omission and advance to the next prescribed exercise or review.", { reason: string("Participant's stated reason; do not pressure.") }, ["reason"]),
    safetyTool(),
  ]),

  active_set: state("Active set", "Execute the current prescribed set without changing its dose.", [
    "When entering from the rest hub, immediately announce the current side/direction and exact set target, then give one concise action cue before waiting for movement.",
    "Wait for speech or [MOTION_PERCEPTION_EVENT]. Motion is evidence, not a command or conversational decision.",
    "When a motion event is uncertain and a current still could clarify visible context, support, framing, or occlusion, call capture_vision_snapshot. Retain motion evidence for temporal counts/trajectories, and never downgrade a safety signal merely because a single image looks normal.",
    "At set entry, say the direct start cue immediately, then wait for movement or a completion report. Never say you are recording/checking and then go silent.",
    "For each actionable event call record_motion_assessment. Count only valid observable reps/holds/steps; unknown is uncertainty, not failure. For routine valid motion, the function call is the only output—do not acknowledge it aloud.",
    "Stay silent for routine valid movement. For correction/retry/uncertainty, give at most one short cue or question after the function result.",
    "Never infer pain, fatigue, fear, breathing, or environmental safety from pose alone.",
    "When the exact target is complete call complete_active_set as the only output; the controller will create the rest/next-task voice turn. Safety concerns take priority and call report_safety_stop.",
  ], [
    tool("record_motion_assessment", "Record the latest semantic motion result.", {
      result: enumeration(["valid", "valid_with_correction", "valid_with_recovery", "retry", "pause", "stop", "unknown"], "Assessment result."),
      observed_count_increment: integer("New valid reps/steps/trials, normally 0 or 1."), issue: string("One factual issue or empty string."),
      confidence: number("Confidence 0 to 1."),
    }, ["result", "observed_count_increment", "issue", "confidence"]),
    tool("complete_active_set", "Record exact set completion and enter rest.", {
      completed_count: integer("Completed reps/steps/trials; use 1 for a completed timed hold."), note: string("Short factual note."),
    }, ["completed_count"]),
    tool("skip_current_exercise", "Record a participant-requested omission and advance to the next prescribed exercise or review.", { reason: string("Participant's stated reason; do not pressure.") }, ["reason"]),
    safetyTool(),
  ]),

  rest: state("Rest hub", "Rest and route to next set, next exercise, extension, completion, early end, or stop.", [
    "A normal completed set is automatically routed by the controller. Do not promise 'next set' and then wait silently.",
    "After automatic routing, immediately introduce the next side/set or next exercise. State the prescribed target and one cue before waiting for movement.",
    "If the participant explicitly asks for rest, calls for a pause, or says they are not ready, call route_from_rest with extend_rest. Strength rest is normally 1-2 minutes unless the prescription differs.",
    "Side switching is already the next set in set_sequence; never create a separate exercise state.",
  ], [tool("route_from_rest", "Route from the shared rest hub.", {
    action: enumeration(["extend_rest", "next_set", "next_exercise", "all_exercises_complete", "end_early", "stop_for_safety"], "Chosen route."),
    reason: string("Short reason when known."),
  }, ["action"])]),

  stop_session: state("Stop session", "Deliver safety response or acknowledge early termination.", [
    "Do not restart or advance to another movement.",
    "For pain/repeated instability advise PT or healthcare follow-up. For fall, chest pain, fainting, severe breathlessness, or severe/new dizziness advise appropriate urgent/emergency help.",
    "Tell the participant to get stable support or sit if safe. Keep it calm and direct, then call complete_stop_session.",
  ], [tool("complete_stop_session", "Enter session review after the stop response.", {
    acknowledged: bool("Stop/early-end message delivered."),
    disposition: enumeration(["pt_follow_up", "healthcare_follow_up", "urgent_or_emergency_help", "participant_ended_early", "unknown"], "Follow-up disposition."),
  }, ["acknowledged", "disposition"])]),

  session_review_and_log: state("Session review and log", "Summarize recorded results/issues and calendar/diary status.", [
    "Summarize only controller-recorded completions, skips, corrections, symptoms, and stop reason.",
    "State the exact weekly-count effect. Do not mark a strength/balance day complete unless its configured completion rule was met.",
    "Walking remains separately logged. Send unresolved issues to PT review without recommending progression.",
    "Call save_session_review with factual results and optional diary note.",
  ], [tool("save_session_review", "Save results, issues, count effect, and diary note.", {
    perceived_difficulty: enumeration(["easy", "appropriate", "hard", "not_reported"], "Reported difficulty."),
    issues_for_pt: strings("Unresolved factual issues."), diary_note: string("Optional deidentified note."),
  }, ["perceived_difficulty", "issues_for_pt"])]),

  wrap_up: state("Wrap up", "Close briefly after the review is stored.", [
    "Thank the participant, repeat already-recorded follow-up in one sentence, and do not introduce new advice.",
    "Call close_session after the short closing message.",
  ], [tool("close_session", "Close the state-machine session.", { closed: bool("Closing message delivered.") }, ["closed"])]),
  completed: state("Completed", "The session is closed.", [
    "Do not start another exercise in the completed run.",
    "If the participant clearly asks to start again, restart, or begin a new session, call start_new_session immediately. This creates a fresh run from greeting using the existing prescription.",
    "Otherwise answer only a simple closing question and direct prescription changes to the PT.",
  ], [tool("start_new_session", "Start a fresh Otago session run from greeting after an explicit participant request.", {
    requested: bool("The participant explicitly requested a new or restarted session."),
  }, ["requested"])]),
};

export function createOtagoStateMachine({ prescription = DEMO_PRESCRIPTION } = {}) {
  let plan = normalizePrescription(prescription);
  let currentState = INITIAL_OTAGO_STATE;
  let warmUpIndex = 0;
  let exerciseIndex = 0;
  let setIndex = 0;
  let observedCount = 0;
  let stopReason = null;
  let runNumber = 1;
  const outcomes = [];
  const history = [{ at: Date.now(), type: "state", from: null, to: currentState, reason: "session_started" }];
  const currentWarmUp = () => plan.warm_up[warmUpIndex] || null;
  const currentExercise = () => plan.exercises[exerciseIndex] || null;
  const currentSet = () => currentExercise()?.set_sequence?.[setIndex] || null;

  function snapshot() {
    return structuredClone({
      current_state: currentState, state_label: STATES[currentState].label,
      prescription_id: plan.prescription_id, prescription_version: plan.prescription_version,
      clinician_reviewed: plan.clinician_reviewed, demo_only: plan.demo_only, program_week: plan.program_week, run_number: runNumber,
      warm_up_index: warmUpIndex, current_warm_up: currentWarmUp(), exercise_index: exerciseIndex,
      current_exercise: currentExercise(), set_index: setIndex, current_set: currentSet(), observed_count: observedCount,
      remaining_exercises: Math.max(0, plan.exercises.length - exerciseIndex), weekly_targets: plan.weekly_targets,
      weekly_history: plan.weekly_history, communication_policy: communicationPolicy(plan.program_week), stop_reason: stopReason, outcomes, history,
    });
  }

  function getInstructions() {
    const definition = STATES[currentState];
    const action = currentState === "warm_up_sequence" ? currentWarmUp() : (["exercise_intro", "form_check", "active_set"].includes(currentState) ? currentExercise() : null);
    const policy = communicationPolicy(plan.program_week);
    return `${getSystemInstruction()}\n\n# Interaction for week ${plan.program_week}\nPhase: ${policy.phase}. Routine output: ${policy.routine_length}. Expand to ${policy.expanded_length} only when ${policy.expand_when.join("; ")}.\n${policy.transition_rule}\nForbidden spoken patterns: promises to record, log, check, mark, update, handle, finalize, or move on later. State writes are silent. If user input completes a function, output only that function call. After its result or [STATE_ADVANCE], give the next useful cue immediately.\n\n# Vision\nThe camera is session-authorized. Capture one still only when it resolves a current visible question; never announce it. Do not recapture without a new question, delay safety action, or let a normal still override symptoms/motion safety evidence.\n\n# State: ${currentState}\nGoal: ${definition.goal}\n${definition.instructions.map((x) => `- ${x}`).join("\n")}\n\n# Functions\nUse only exposed functions. Never say function names, JSON, hidden state, or reasoning. Function results authorize transitions/counts/completion; safety overrides all.\n\n${action ? `# Current action\n${getActionInstruction(action)}\n\n` : ""}# Runtime\n${JSON.stringify(runtimeContext())}`;
  }

  function runtimeContext() {
    const identity = { id: plan.prescription_id, version: plan.prescription_version, week: plan.program_week };
    const exercise = currentExercise();
    const currentAction = exercise ? { id: exercise.id, name: exercise.name, category: exercise.category } : null;
    const latestExerciseOutcome = exercise ? [...outcomes].reverse().find((item) => item.exercise_id === exercise.id) || null : null;

    if (currentState === "greeting") return { state: currentState, prescription: identity, demo_only: plan.demo_only };
    if (currentState === "readiness_check") return {
      state: currentState, prescription: identity,
      required_setup: readinessRequirements(plan),
    };
    if (currentState === "plan_briefing") return {
      state: currentState,
      prescription: { ...identity, effective_date: plan.effective_date, duration_weeks: plan.program_duration_weeks },
      weekly_targets: plan.weekly_targets, weekly_history: plan.weekly_history,
      today: todayActionNames(plan), walking_plan: plan.walking_plan,
    };
    if (currentState === "warm_up_sequence") return {
      state: currentState, prescription: identity,
      item_number: warmUpIndex + 1, item_count: plan.warm_up.length, current_action: currentWarmUp(),
    };
    if (["exercise_intro", "form_check", "active_set"].includes(currentState)) return {
      state: currentState, prescription: identity,
      exercise_number: exerciseIndex + 1, exercise_count: plan.exercises.length, exercise: currentAction,
      set_number: setIndex + 1, set_count: exercise?.set_sequence?.length || 0, set: currentSet(), observed_count: observedCount,
      latest_relevant_outcome: compactOutcome(latestExerciseOutcome),
    };
    if (currentState === "rest") return {
      state: currentState, prescription: identity, exercise: currentAction, completed_set: currentSet(), default_route: defaultRestRoute(),
    };
    if (currentState === "stop_session") return { state: currentState, prescription: identity, stop_reason: stopReason };
    if (["session_review_and_log", "wrap_up"].includes(currentState)) return {
      state: currentState, prescription: identity, session_results: summarizeOutcomes(outcomes), weekly_count_effect: weeklyEffect(), stop_reason: stopReason,
    };
    return { state: currentState, prescription: identity };
  }

  function getTools() {
    const tools = structuredClone(STATES[currentState].tools);
    if (currentState !== "completed") tools.push(visionTool());
    return tools;
  }

  function execute(name, args = {}) {
    if (!getTools().some((x) => x.name === name)) return fail(`Tool ${name} is not available in state ${currentState}.`);
    if (name === "capture_vision_snapshot") {
      const request = {
        purpose: args.purpose || "other",
        focus: String(args.focus || "current visible coaching context"),
        reason: String(args.reason || ""),
      };
      history.push({ at: Date.now(), type: "vision_requested", state: currentState, ...request });
      return stay("Vision snapshot requested.", { capture_vision: true, vision_request: request }, false);
    }
    if (name === "report_safety_stop") {
      stopReason = { concern: args.concern || "other", evidence: args.evidence || [], note: args.note || "" };
      outcomes.push({ type: "safety_stop", ...stopReason });
      return transition("stop_session", `safety:${stopReason.concern}`);
    }
    switch (name) {
      case "complete_greeting": return args.ready_for_check ? transition("readiness_check", "greeting_complete") : stay("Await clear agreement.");
      case "record_readiness": {
        outcomes.push({ type: "readiness", ...pick(args, ["no_warning_symptoms", "illness_cleared", "equipment_ready", "environment_clear", "concern", "note"]) });
        const safe = args.no_warning_symptoms && args.illness_cleared && args.equipment_ready && args.environment_clear && args.concern === "none";
        if (safe) return transition("plan_briefing", "ready_to_start");
        stopReason = { concern: args.concern || "readiness_failed", evidence: ["user_report", "readiness_check"], note: args.note || "" };
        return transition("stop_session", `unsafe_to_start:${stopReason.concern}`);
      }
      case "confirm_plan_briefing": return args.understood ? transition("warm_up_sequence", "plan_briefed") : stay("Clarify the plan before advancing.");
      case "record_warm_up_item": {
        outcomes.push({ type: "warm_up", action_id: currentWarmUp()?.id, ...pick(args, ["outcome", "note"]) });
        if (args.outcome === "stop") { stopReason = { concern: "warm_up_stop", evidence: ["user_report"], note: args.note || "" }; return transition("stop_session", "warm_up_stop"); }
        if (args.outcome === "pause") return stay("Warm-up remains paused; resolve uncertainty or stop safely.");
        warmUpIndex += 1;
        return transition(warmUpIndex < plan.warm_up.length ? "warm_up_sequence" : (plan.exercises.length ? "exercise_intro" : "session_review_and_log"), warmUpIndex < plan.warm_up.length ? "next_warm_up_item" : "warm_up_complete");
      }
      case "begin_form_check": return args.ready ? transition("form_check", "exercise_introduced") : stay("Participant has not agreed to set up.");
      case "skip_current_exercise": outcomes.push({ type: "exercise_skip", exercise_id: currentExercise()?.id, reason: args.reason || "participant_requested" }); return advanceExercise("exercise_skipped");
      case "record_form_check": {
        outcomes.push({ type: "form_check", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, ...pick(args, ["outcome", "issue", "evidence"]) });
        if (args.outcome === "ready") return transition("active_set", "setup_ready");
        if (["unsafe_setup", "symptom_detected"].includes(args.outcome)) { stopReason = { concern: args.outcome, evidence: args.evidence || [], note: args.issue || "" }; return transition("stop_session", args.outcome); }
        return stay("Setup correction recorded. Give one correction and re-check.");
      }
      case "record_motion_assessment": {
        const assessment = { type: "motion_assessment", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, ...pick(args, ["result", "observed_count_increment", "issue", "confidence"]) };
        outcomes.push(assessment); observedCount += Math.max(0, Number(args.observed_count_increment) || 0);
        if (args.result === "stop") { stopReason = { concern: args.issue || "motion_safety_stop", evidence: ["motion"], note: args.issue || "" }; return transition("stop_session", "motion_safety_stop", { assessment }); }
        if (["valid_with_correction", "retry", "pause", "unknown"].includes(args.result)) return transition("form_check", `motion:${args.result}`, { assessment });
        return stay("Motion assessment recorded.", { assessment, speak: args.result === "valid_with_recovery" }, args.result === "valid_with_recovery");
      }
      case "complete_active_set": {
        outcomes.push({ type: "set_complete", exercise_id: currentExercise()?.id, set_id: currentSet()?.set_id, ...pick(args, ["completed_count", "note"]) });
        observedCount = 0;
        const result = transition("rest", "set_complete");
        result.auto_route = defaultRestRoute();
        result.continue_response = false;
        return result;
      }
      case "route_from_rest": return routeFromRest(args);
      case "complete_stop_session": outcomes.push({ type: "stop_disposition", ...pick(args, ["acknowledged", "disposition"]) }); return args.acknowledged ? transition("session_review_and_log", "stop_handled") : stay("Finish the stop message first.");
      case "save_session_review": {
        const review = { type: "session_review", ...pick(args, ["perceived_difficulty", "issues_for_pt", "diary_note"]), weekly_count_effect: weeklyEffect() };
        outcomes.push(review); return transition("wrap_up", "review_saved", { session_review: review });
      }
      case "close_session": return args.closed ? transition("completed", "session_closed", { continue_response: false }) : stay("Deliver the closing message first.");
      case "start_new_session": return args.requested ? restartRun() : stay("Await an explicit request to start a new session.");
      default: return fail(`Unknown tool ${name}.`);
    }
  }

  function routeFromRest(args) {
    if (args.action === "extend_rest") return stay("Rest extended.", {}, false);
    if (args.action === "next_set") {
      if (setIndex + 1 >= (currentExercise()?.set_sequence?.length || 0)) return fail("No next set exists; choose next_exercise or finish.");
      setIndex += 1; observedCount = 0; return transition("active_set", "next_set");
    }
    if (args.action === "next_exercise") return advanceExercise("next_exercise");
    if (args.action === "all_exercises_complete") {
      if (exerciseIndex + 1 < plan.exercises.length) return fail("Prescribed exercises remain. Use next_exercise or explicitly skip them.");
      return transition("session_review_and_log", "all_exercises_complete");
    }
    if (args.action === "end_early" || args.action === "stop_for_safety") {
      stopReason = { concern: args.action === "end_early" ? "participant_ended_early" : (args.reason || "safety_concern"), evidence: ["user_report"], note: args.reason || "" };
      outcomes.push({ type: args.action, ...stopReason }); return transition("stop_session", args.action);
    }
    return fail("Unsupported rest route.");
  }

  function defaultRestRoute() {
    if (setIndex + 1 < (currentExercise()?.set_sequence?.length || 0)) return "next_set";
    if (exerciseIndex + 1 < plan.exercises.length) return "next_exercise";
    return "all_exercises_complete";
  }

  function autoRouteFromRest() {
    if (currentState !== "rest") return fail("Automatic rest routing is only available in the rest state.");
    const action = defaultRestRoute();
    return routeFromRest({ action, reason: "controller_default_after_completed_set" });
  }

  function advanceExercise(reason) { exerciseIndex += 1; setIndex = 0; observedCount = 0; return transition(exerciseIndex < plan.exercises.length ? "exercise_intro" : "session_review_and_log", reason); }
  function restartRun() {
    const previous = currentState;
    runNumber += 1;
    warmUpIndex = 0; exerciseIndex = 0; setIndex = 0; observedCount = 0; stopReason = null;
    outcomes.splice(0); history.splice(0);
    currentState = "greeting";
    history.push({ at: Date.now(), type: "state", from: previous, to: currentState, reason: "new_session_requested" });
    return { ok: true, state_changed: true, previous_state: previous, current_state: currentState, reason: "new_session_requested", snapshot: snapshot(), continue_response: true };
  }
  function transition(next, reason, extra = {}) { const previous = currentState; currentState = next; history.push({ at: Date.now(), type: "state", from: previous, to: next, reason }); return { ok: true, state_changed: previous !== next, previous_state: previous, current_state: next, reason, snapshot: snapshot(), continue_response: true, ...extra }; }
  function stay(message, extra = {}, continueResponse = true) { return { ok: true, state_changed: false, current_state: currentState, message, snapshot: snapshot(), continue_response: continueResponse, ...extra }; }
  function fail(error) { return { ok: false, state_changed: false, current_state: currentState, error, snapshot: snapshot(), continue_response: true }; }

  function setPrescription(next) {
    if (!["greeting", "readiness_check", "plan_briefing"].includes(currentState)) return fail("Prescription can only be replaced before warm-up begins.");
    try { plan = normalizePrescription(next); warmUpIndex = exerciseIndex = setIndex = observedCount = 0; history.push({ at: Date.now(), type: "prescription", prescription_id: plan.prescription_id }); return stay("Prescription loaded.", { prescription_loaded: true }, false); }
    catch (error) { return fail(error.message); }
  }

  function weeklyEffect() {
    const done = new Set(outcomes.filter((x) => x.type === "set_complete").map((x) => x.exercise_id));
    const strength = plan.exercises.filter((x) => x.category === "strength").map((x) => x.id);
    const balance = plan.exercises.filter((x) => x.category === "balance").map((x) => x.id);
    const strengthDay = strength.length > 0 && strength.every((id) => done.has(id));
    const balanceDay = balance.length > 0 && balance.every((id) => done.has(id));
    return { strength_day_completed: strengthDay, balance_day_completed: balanceDay,
      strength_days_after_session: plan.weekly_history.strength_days_completed + Number(strengthDay),
      balance_days_after_session: plan.weekly_history.balance_days_completed + Number(balanceDay), walking_days_unchanged: plan.weekly_history.walking_days_completed };
  }
  return { snapshot, getInstructions, getTools, execute, setPrescription, autoRouteFromRest };
}

export function getOtagoStateDefinitions() { return structuredClone(STATES); }

export function normalizePrescription(value) {
  if (!value || typeof value !== "object") throw new Error("Prescription must be an object.");
  const plan = structuredClone(value);
  plan.prescription_id = String(value.prescription_id || "unnamed-prescription"); plan.prescription_version = String(value.prescription_version || "unversioned");
  plan.clinician_reviewed = Boolean(value.clinician_reviewed); plan.demo_only = Boolean(value.demo_only); plan.program_week = Number(value.program_week || 1); plan.program_duration_weeks = Number(value.program_duration_weeks || 52);
  plan.weekly_targets = value.weekly_targets || {}; plan.weekly_history = { strength_days_completed: 0, balance_days_completed: 0, walking_days_completed: 0, ...(value.weekly_history || {}) };
  plan.walking_plan = value.walking_plan || null; plan.clinician_only_decisions = Array.isArray(value.clinician_only_decisions) ? value.clinician_only_decisions : [];
  plan.warm_up = Array.isArray(value.warm_up) ? value.warm_up.map((x, i) => validateAction(x, i, "warm_up")) : [];
  plan.exercises = Array.isArray(value.exercises) ? value.exercises.map((x, i) => validateAction(x, i, x.category)) : [];
  if (!plan.warm_up.length) throw new Error("Prescription requires warm_up."); if (!plan.exercises.length) throw new Error("Prescription requires strength or balance exercises.");
  for (const exercise of plan.exercises) if (!Array.isArray(exercise.set_sequence) || !exercise.set_sequence.length) throw new Error(`Exercise ${exercise.id} requires set_sequence.`);
  return plan;
}

function validateAction(action, index, category) {
  if (!action?.id || !action?.name) throw new Error(`Action ${index + 1} requires id and name.`);
  if (!listSupportedActionIds().includes(action.id)) throw new Error(`Unsupported instruction id: ${action.id}.`);
  if (!["warm_up", "strength", "balance"].includes(category)) throw new Error(`Action ${action.id} has invalid category.`);
  return structuredClone({ ...action, category });
}
function communicationPolicy(programWeek) {
  if (programWeek <= 2) return {
    phase: "early familiarization", default_detail: "two or three short sentences for each new action", routine_length: "one short instruction plus a readiness check", expanded_length: "two or three short sentences",
    expand_when: ["a new exercise or side begins", "the participant asks for repetition or clarification", "motion is uncertain or form needs correction", "a safety concern occurs"],
    transition_rule: "Name the next action, prescribed target, support, and one key cue before asking the participant to begin.",
  };
  if (programWeek <= 6) return {
    phase: "skill consolidation", default_detail: "one or two short sentences", routine_length: "one concise cue", expanded_length: "two short sentences",
    expand_when: ["the action is new in today’s session", "the participant asks", "motion is uncertain or correction is needed", "the prescription changed", "a safety concern occurs"],
    transition_rule: "Name the next action and target, then give only the single most useful cue.",
  };
  return {
    phase: "maintenance / familiar practice", default_detail: "one short sentence", routine_length: "one direct instruction of no more than about 12 spoken words", expanded_length: "at most two short sentences",
    expand_when: ["the participant explicitly asks how, why, or asks for repetition", "this is the first attempt at a newly added or changed prescription item", "motion is uncertain, repeated correction is needed, or a safety concern occurs"],
    transition_rule: "After an automatic set transition, immediately state the next side/task and its target; do not re-explain familiar setup, clinical rationale, or the entire session plan.",
  };
}
function todayActionNames(plan) {
  return {
    warm_up: plan.warm_up.map((item) => item.name),
    strength: plan.exercises.filter((item) => item.category === "strength").map((item) => item.name),
    balance: plan.exercises.filter((item) => item.category === "balance").map((item) => item.name),
  };
}
function readinessRequirements(plan) {
  const supports = new Set();
  const ankleWeights = new Set();
  for (const item of plan.warm_up) if (item.support) supports.add(item.support);
  for (const exercise of plan.exercises) {
    for (const setSpec of exercise.set_sequence || []) {
      if (setSpec.support) supports.add(setSpec.support);
      if (Number(setSpec.ankle_weight_kg) > 0) ankleWeights.add(Number(setSpec.ankle_weight_kg));
    }
  }
  return { supports: [...supports], ankle_weights_kg: [...ankleWeights].sort((a, b) => a - b), clear_movement_space: true, camera_framing: "current action body parts and support visible" };
}
function compactOutcome(item) {
  if (!item) return null;
  return pick(item, ["type", "exercise_id", "set_id", "result", "outcome", "issue", "confidence", "completed_count", "reason"]);
}
function summarizeOutcomes(items) {
  return {
    warm_up: items.filter((item) => item.type === "warm_up").map((item) => pick(item, ["action_id", "outcome", "note"])),
    completed_sets: items.filter((item) => item.type === "set_complete").map((item) => pick(item, ["exercise_id", "set_id", "completed_count", "note"])),
    skipped_exercises: items.filter((item) => item.type === "exercise_skip").map((item) => pick(item, ["exercise_id", "reason"])),
    issues: items.filter((item) => item.type === "motion_assessment" && item.result !== "valid").map(compactOutcome),
    safety_events: items.filter((item) => ["safety_stop", "end_early", "stop_for_safety"].includes(item.type)).map((item) => pick(item, ["type", "concern", "evidence", "note"])),
  };
}
function state(label, goal, instructions, tools) { return { label, goal, instructions, tools }; }
function tool(name, description, properties, required = []) { return { type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false } }; }
function safetyTool() { return tool("report_safety_stop", "Immediately stop for a reported or clearly observed safety concern.", { concern: enumeration(symptoms, "Concern."), evidence: strings("Evidence sources."), note: string("Short factual note.") }, ["concern", "evidence"]); }
function visionTool() { return tool("capture_vision_snapshot", "Silently capture one current camera still when visible evidence would reduce questioning or clarify the present coaching decision. This does not change the state.", {
  purpose: enumeration(["environment_readiness", "equipment_check", "exercise_setup", "form_clarification", "motion_uncertainty", "framing_check", "other"], "What visual question this one snapshot should address."),
  focus: string("One concise, concrete description of the visible evidence to inspect."),
  reason: string("Why the image is useful now; keep factual and brief."),
}, ["purpose", "focus"]); }
function string(description) { return { type: "string", description }; } function bool(description) { return { type: "boolean", description }; }
function integer(description) { return { type: "integer", minimum: 0, description }; } function number(description) { return { type: "number", minimum: 0, maximum: 1, description }; }
function enumeration(values, description) { return { type: "string", enum: values, description }; } function strings(description) { return { type: "array", items: { type: "string" }, description }; }
function pick(source, keys) { return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, structuredClone(source[key])])); }
