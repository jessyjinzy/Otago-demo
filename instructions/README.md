# Otago Home-Exercise State Machine and Motion Interface

This folder contains the current prompt and state-machine specification for the Otago home-exercise coach. The current version keeps the original state machine's simple exercise loop, but adds the minimum scheduling, safety, and prescription interfaces needed for an Otago-specific implementation.

Walking is intentionally out of scope for this version.

## 1. What changed from the original state machine

The original core loop was approximately:

```text
greeting
-> plan_briefing
-> warm_up
-> exercise_intro
-> form_check
-> active_set
-> rest (hub)
-> cooldown_stretch
-> wrap_up
```

It also included a general `plan_update` state and early transitions from several states to `wrap_up`.

The current version makes the following changes.

### 1.1 Added `readiness_check`

`readiness_check` runs after `greeting` and before loading the daily plan. It checks:

- illness or a recent interruption;
- reported pain, dizziness, chest pain, or severe shortness of breath;
- required equipment and support objects;
- whether the environment and sensor view are adequate.

An unsafe result transitions to `stop_session` rather than entering the exercise sequence.

### 1.2 `plan_briefing` now loads a PT-approved prescription

`plan_briefing` does not ask the AI to invent a workout. It loads the active `prescription_version` and explains the warm-up, strength, and balance exercises selected by the PT.

The exercise pool is fixed. The AI may not generate a new movement to replace a missing or skipped exercise.

### 1.3 Made the warm-up sequence explicit

`warm_up_sequence` represents:

```text
three breathing cycles
-> head movements
-> neck movements
-> trunk movements
-> ankle movements
-> back extension
```

Warm-up is required before every supervised strength or balance session.

### 1.4 Added `skip exercise`

The user can skip a prescribed strength or balance exercise. The transition must perform an action such as:

```text
skipCurrentExercise(reason)
advanceExerciseIndex()
re-enter exercise_intro
```

The skip transition must advance the exercise queue before re-entering `exercise_intro`; otherwise, it becomes an infinite self-loop. A skipped exercise is recorded as skipped, not completed, and is not replaced with an unprescribed exercise.

### 1.5 Preserved `rest (hub)`

`rest` remains the central router after every completed set or balance trial. It selects:

- `next set`, including a change of side already encoded in `set_sequence`;
- `next exercise`;
- `extend rest`;
- `end early`;
- `all exercises complete`.

Side switching is data in `set_sequence`, not a separate state.

### 1.6 Added a form-correction loop

During `active_set`, a correctable form issue returns to `form_check`:

```text
active_set
-> form correction needed
-> form_check
-> active_set
```

This loop is for correcting the current prescribed action. It does not modify the clinical prescription.

### 1.7 Removed `plan_update`

The original `plan_update` state mixed two different concepts: temporary session control and clinical prescription changes.

Temporary actions are now handled by existing states and transitions:

- additional rest: `rest -> rest`;
- retry or correction: `active_set -> form_check`;
- skip: advance the queue and re-enter `exercise_intro`;
- early termination: transition to `stop_session` or `session_review_and_log`.

Clinical changes such as increasing weight, removing support, adding an exercise, or changing the dose are not performed inside the home-session state machine. They arrive through a new PT-authored `prescription_version`.

### 1.8 Added explicit routes to `stop_session`

The current graph includes:

```text
readiness_check -- unsafe to start --> stop_session
warm_up_sequence -- symptom detected --> stop_session
form_check -- unsafe setup --> stop_session
active_set -- pain / dizziness / instability / fall --> stop_session
rest -- user requests stop --> stop_session
```

`stop_session` performs the safety response or early-termination behavior and then enters `session_review_and_log`. This ensures that partial completion, symptoms, falls, and unresolved issues are recorded even when the session does not finish normally.

### 1.9 Replaced `cooldown_stretch` with `session_review_and_log`

The generic `cooldown_stretch` state was removed because it was not a universal Otago strength/balance requirement. Both normal and early completion now converge on:

```text
session_review_and_log
-> wrap_up
-> close_session
```

### 1.10 Generalized `active_set`

The current diagram keeps one compact `active_set` state:

```text
active_set(
  exercise_id,
  side,
  weight,
  repetitions | hold_time | step_count,
  support_level
)
```

Strength and balance use different parameters, but share the same outer transition structure. Internally, the executor should dispatch according to `exercise_type`.

## 2. Weekly counting and scheduling

The daily state machine is not sufficient to enforce Otago frequency. We need a persistent weekly layer outside the session state machine.

Use the participant's local timezone and a clearly defined week boundary, preferably ISO Monday-Sunday. Count unique calendar dates, not the number of times the user reconnects or starts a new realtime session on the same date.

Program requirements:

- Strength: three days per week, with at least one non-strength rest day between strength days.
- Balance: at least three days per week; it may be performed daily when prescribed.
- Warm-up: required before any strength or balance block.

The user may omit some strength or balance exercises on a given day. Therefore, do not store only a single boolean. Record each block as:

```text
not_scheduled | not_started | completed | partial | skipped | stopped_for_safety
```

A day should count as a fully completed strength or balance day only when the configured completion rule is satisfied. A partial day must remain visible and must not be silently converted into a completed day. The PT or study protocol should define whether a particular completion ratio can count toward adherence.

Recommended weekly record:

```json
{
  "week_id": "2026-W35",
  "timezone": "America/New_York",
  "strength": {
    "target_days": 3,
    "completed_days": ["2026-08-24"],
    "partial_days": ["2026-08-26"],
    "last_strength_date": "2026-08-26"
  },
  "balance": {
    "target_days": 3,
    "completed_days": ["2026-08-24", "2026-08-25"],
    "partial_days": []
  },
  "sessions": []
}
```

Before a session, expose at least:

```text
getWeeklyProgress(date, timezone)
canScheduleStrength(date)
recordSessionResult(session_result)
```

`canScheduleStrength` should detect consecutive strength days. It should not allow multiple sessions on one date to inflate the weekly count.

## 3. Prescription interface

The PT may update the plan over time. The state machine should receive a versioned prescription rather than embedding exercise details in prompts or transition code.

Minimum structure:

```json
{
  "prescription_version": "v3",
  "effective_date": "2026-08-24",
  "warm_up": [
    {
      "exercise_id": "head_movements",
      "repetitions_per_side": 5
    }
  ],
  "strength": [
    {
      "exercise_id": "front_knee_strengthening",
      "sets": [
        {"side": "left", "weight_lb": 5, "repetitions": 10},
        {"side": "right", "weight_lb": 5, "repetitions": 10}
      ]
    }
  ],
  "balance": [
    {
      "exercise_id": "heel_toe_stand",
      "sets": [
        {
          "front_foot": "left",
          "hold_seconds": 10,
          "repetitions": 5,
          "support_level": "1H"
        }
      ]
    }
  ],
  "restrictions": [],
  "pt_notes": []
}
```

Required interface behavior:

- load one active version at session start;
- keep that version immutable during the session;
- log the version with every session result;
- treat missing essential parameters as `pause`, not permission to guess;
- activate progression only when a new PT-authored version is received.

Walking is not included in this interface or state machine for the current milestone.

## 4. Motion-detection challenges requiring explicit support

The following are the nontrivial cases that require more than ordinary joint-angle or repetition detection. Straightforward movements can use the normal pose-quality pipeline and are omitted here.

### 4.1 Support level across multiple exercises

Relevant exercises include calf raises, toe raises, knee bends, heel-toe stand, one-leg stand, backward walking, heel-toe walking, heel walking, and toe walking.

The prescription may require as `support_level`:

```text
2H = two-hand support
1H = one-hand support
NS = no support
```

Detecting this requires hand-to-object contact, not just hand position. We need the chair, countertop, wall, or handrail represented in the scene and need temporal contact logic robust to brief occlusion. The output should distinguish prescribed contact, unexpected grabbing, and uncertain contact.

### 4.2 Sit to stand

Required difficulty:

- detect whether the user uses two hands, one hand, or no hands, according to the prescription;
- distinguish hand contact with the chair from hands merely passing near the chair;
- detect initial and final chair contact;
- verify full standing before descent;
- detect a controlled return rather than an uncontrolled drop into the chair.

Useful outputs:

```text
hand_assistance_observed: 2H | 1H | NS | unknown
seat_contact: true | false | unknown
full_stand_reached: true | false
descent_controlled: true | false | unknown
```

### 4.3 Heel-toe stand and heel-toe walking

The main difficulty is determining whether the feet form a near-straight tandem line and whether the heel is placed close to the other foot's toes.

This requires reliable heel and toe landmarks, a ground plane, foot orientation, and a world-coordinate line of progression. A body skeleton without articulated feet may not be sufficient. Foot occlusion must return `unknown`, not `incorrect`.

For heel-toe walking, count only tandem steps. Turning, adjustment steps, and recovery steps must not be counted as prescribed steps.

Useful outputs:

```text
tandem_alignment_error
heel_to_toe_gap
valid_tandem_step_count
recovery_step_count
```

### 4.4 Heel-toe walking backwards

This combines tandem foot placement with backward global motion. Detect:

- backward pelvis/root displacement;
- torso orientation remaining generally forward;
- near-tandem foot placement;
- prescribed step count;
- turn boundaries;
- separation of normal, adjustment, and recovery steps.

### 4.5 Walking and turning - figure-eight trajectory

This cannot be detected reliably from per-frame posture alone. It requires a temporally integrated world-coordinate root or pelvis trajectory.

The system should detect:

- two connected path lobes;
- one clockwise and one counter-clockwise turn;
- travel through the center region;
- return near the starting region;
- completion of the full pattern before counting one repetition.

Useful outputs:

```text
trajectory_points
clockwise_loop_complete
counterclockwise_loop_complete
center_crossing_detected
returned_to_start_region
figure_eight_complete
```

### 4.6 Sideways walking versus ordinary walking

Detect the relationship between body orientation and global displacement. In sideways walking, the pelvis moves laterally while the torso generally remains facing forward. Turning the whole body and walking forward should not count as sideways walking.

The detector must also separate right and left segments and exclude turning, adjustment, and recovery steps.

### 4.7 Backwards walking

Detect backward global displacement relative to body orientation. Separate backward steps from the turn at the end of the path. Track the support-hand change when the prescription requires the user to turn and return with the other hand near the support surface.

### 4.8 One-leg stand

The detector must identify:

- which foot is the stance foot;
- whether the other foot is actually clear of the floor;
- hold duration before a foot touch;
- hopping, recovery steps, and unexpected hand support;
- the difference between controlled recovery and a near fall.

Ground contact cannot be inferred reliably from ankle height alone when floor calibration or foot tracking is poor.

### 4.9 Calf raises, toe raises, heel walking, and toe walking

These exercises require fine-grained foot-ground contact:

- calf raises and toe walking require heel elevation;
- toe raises and heel walking require forefoot elevation while the heel remains down.

A coarse body skeleton may miss these differences. Prefer articulated foot keypoints or a reconstructed foot mesh plus ground-plane contact. Detect symmetric versus asymmetric elevation and distinguish the active phase from turns and setup.

### 4.10 Stair walking

This requires stair and handrail geometry in addition to the human body. Detect step index, ascent versus descent, foot-to-step contact, continuous required handrail use, pauses, missed steps, and loss of balance.

Stair walking must not start unless the prescription enables it and the external supervision protocol confirms close supervision. The visual presence of another person is not sufficient evidence of qualified supervision.

### 4.11 Controlled recovery versus safety failure

Otago permits a confident lower-body recovery step during balance practice. Therefore, the motion module should not treat every extra step as failure.

Distinguish:

```text
normal prescribed step
controlled recovery step
repeated uncontrolled stepping
unexpected arm grab
near fall
fall
```

Recommended trial outcomes:

```text
valid
valid_with_recovery
valid_with_correction
retry
pause
stop
unknown
```

### 4.12 Prescribed ankle weight is not a motion-estimation problem

The exact ankle weight cannot be reliably inferred from body reconstruction. Read it from the prescription and confirm it through the equipment interface or user/PT confirmation. Motion should only assess whether the movement performed under that declared load satisfies observable form and tempo requirements.

