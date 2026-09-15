# Otago Coach — Realtime 2.1 state-machine design

## Design objective

The coach is not a single prompt that improvises an exercise session. The local application owns an explicit state, the physical therapist owns the prescription, the motion module supplies observations, and Realtime 2.1 interprets conversation and selects the appropriate function within the current state.

The core separation is:

```text
Therapist prescription = what may be practiced
Motion module          = what movement was observed
Realtime 2.1           = what the user may need and which function to call
Local state machine    = whether that call is valid and what state follows
Realtime speech        = how the validated action is communicated
```

## State flow

| State | Goal | Normal exit | Important jump |
|---|---|---|---|
| `orientation` | Explain role, limits, and session outline | `finish_orientation` | User declines: stay or end |
| `preference_onboarding` | Collect minimal communication preferences | `save_preferences` | Skip optional details with balanced defaults |
| `readiness_check` | Check user, environment, and prescribed support | `record_readiness` | Any concern → `safety_pause` |
| `warm_up` | Guide only prescribed warm-up | `complete_warm_up` | Stop/decline → review; concern → safety |
| `exercise_briefing` | Give target, support, and one cue | `start_current_exercise` | Concern → safety |
| `active_exercise` | Infer conversational need and choose intervention | `complete_current_exercise` | Break or safety at any time |
| `recovery_check` | Check response before the next task | `record_recovery` | Tired → break; concern → safety |
| `break` | Permit quiet recovery | `resume_after_break` | Concern → safety; user stops → review |
| `session_reflection` | Summarize observed outcomes and capture feedback | `finish_session` | — |
| `safety_pause` | Stop and direct to human help | `close_after_safety_message` | No autonomous restart |
| `completed` | Close without adding tasks | terminal | — |

The loop `exercise_briefing → active_exercise → recovery_check` repeats over the ordered prescription. The server, not the model, advances the exercise index.

## Dynamic prompt and tool policy

Each state exposes only its own short instructions and minimal functions. After a function succeeds, the server sends:

1. `conversation.item.create` with a `function_call_output`;
2. a new `session.update` containing the next state's prompt and tool list;
3. `response.create` if a spoken follow-up is useful.

This avoids asking the model to remember a large state graph and prevents invalid calls such as finishing an exercise during preference onboarding. Parallel tool calls are disabled because two simultaneous state-changing functions could conflict.

## Active-exercise decision loop

For every semantic `[MOTION_OBSERVATION]`, Realtime first calls:

```text
record_intervention_decision(
  action: silence | encourage | correct | clarify | offer_break | stop_for_safety,
  evidence: motion | speech_content | prosody | response_latency |
            interruption | response_to_prior_feedback,
  rationale,
  confidence
)
```

`silence` ends the decision turn without audio. A speaking decision lets Realtime produce one concise intervention. The separate `update_user_state` function records evidence-grounded changes such as confusion, confidence, anxiety, or feedback overload.

The model is explicitly prohibited from inferring fatigue, pain, fear, or confusion from motion alone. A visually ambiguous change should trigger a short clarification only when the answer changes the next safe action.

## Why Realtime 2.1 is relevant

- Reasoning effort can be set to `low` as the latency baseline and raised only when evals show better state or tool decisions.
- Stronger tool selection makes state-specific functions more viable than they were with earlier Realtime models.
- The 128k context window can retain a longer session history, including prior interventions and user responses, while authoritative state remains local.
- Better silence, noise, and interruption handling is directly relevant to exercising users who pause, breathe, move away from the microphone, or interrupt guidance.
- Dynamic `session.update` lets the application replace a large global flow with the active state's short prompt and minimal tools.
- Function calls turn decisions into inspectable logs that can be evaluated separately from speech quality.

These capabilities do not by themselves create a clinically valid coach. The system still requires a clinician-reviewed prescription, validated motion observations, safety evaluation, and user studies.

## Research value beyond the demo

The prompt-based Realtime 2.1 policy is a strong prototype and baseline, not the final research contribution. Its logs support evaluation of:

- state-transition accuracy;
- unnecessary-intervention and missed-intervention rates;
- whether clarification resolves motion ambiguity;
- whether the next repetitions improve after a correction;
- whether the system adapts to feedback cadence and detail preferences;
- tool-call latency and end-to-end speech latency;
- safety-stop recall and false alarms.

The later research model can replace or supervise `update_user_state` and `record_intervention_decision` while preserving the same state-machine and tool interface.
