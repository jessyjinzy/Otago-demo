# Otago Realtime Coach v7

V7 is a research prototype of a voice-first Otago home-exercise coach. It combines a compact deterministic session controller, GPT Realtime conversation, action-specific motion detectors, an open-world activity supervisor, and targeted camera snapshots.

The current prototype intentionally treats the prescribed program as a two-action sequence:

1. **Knee bends:** 5 repetitions, bilateral, with two-hand support on a stable chair.
2. **One-leg stand:** 10 seconds with the left foot lifted, then 10 seconds with the right foot lifted, with one-hand chair support.

This is a technical demonstration, not a medical device or a complete Otago prescription. It does not replace a physical therapist and must not be used to make independent clinical progression decisions.

## Current session flow

The default prescription uses the complete interaction flow; the old fast opening is disabled.

```text
greeting
  → readiness_check
  → plan_briefing
  → exercise_intro: knee bends
  → set_readiness
  → active_set: 5 knee bends
  → 15-second rest
  → exercise_intro: one-leg stand
  → set_readiness
  → active_set: left side, 10 seconds
  → active_set: right side, 10 seconds
  → 15-second rest
  → session_review_and_log
  → wrap_up / completed

Any confirmed safety concern
  → stop_session → session_review_and_log → completed
```

The opening includes a natural week-aware greeting, one environment image plus the minimum necessary symptom/illness questions, a week 8 of 52 progress briefing, the weekly balance target, and today's two actions. There is no warm-up sequence in this bounded prototype. A real Otago session must use its PT-approved warm-up and complete prescription.

## Architecture

```text
Microphone audio ───────────────────────────────────────┐
Targeted JPEG snapshots ────────────────────────────────┤
                                                       ▼
Browser client → local authenticated relay → XTY GPT Realtime
      ▲                                      │
      │                                      │ function calls
      │                                      ▼
Joint frames → motion perception → compact deterministic controller
                  │                          │
                  ├─ action-specific rules   ├─ session cursor
                  ├─ global safeguards       ├─ authoritative counts
                  └─ open-world supervisor   └─ safety and progression
```

- **Realtime agent:** natural conversation, concise coaching, interpreting speech and structured visual evidence, and selecting an exposed function.
- **Controller:** exact session state, exercise/set order, prescribed dose, accepted count, weekly completion, and safety lockout.
- **Action detector:** phases, valid repetitions, timed holds, and action-specific errors from joint coordinates.
- **Open-world supervisor:** sustained activity not explained by the prescribed action. It does not classify every Otago exercise.
- **Vision:** visible activity, setup, support, occlusion, and framing. It does not count repetitions or prove medical safety.

The language model never receives the high-rate skeleton stream. It receives only compact controller results that matter for conversation or intervention.

## Motion processing

The input boundary accepts SMPL-24 global 3D joint positions. At runtime, the prototype keeps ten essential joints: pelvis, neck, and bilateral hip, knee, ankle, and foot joints. Raw source data may be 30 FPS; exercise rules operate at 5–10 FPS.

### Knee-bend detector

The detector calculates bilateral hip–knee–ankle angles and pelvis-to-neck trunk lean.

- descent: knee angle below 140°;
- return to standing: above 158°;
- maximum left/right knee-angle difference: 18°;
- maximum trunk lean from vertical: 22°;
- one complete down–up cycle emits `rep_completed`.

It emits `rep_started` before completion, so the controller knows a repetition is underway.

### One-leg-stand detector

Distances are normalized by reconstructed leg length.

- lifted ankle height: at least 0.18 leg lengths above the stance ankle;
- stance-foot drift: at most 0.12 leg lengths;
- pelvis sway: at most 0.22 leg lengths;
- trunk lean: at most 20°;
- completion: 10 continuous valid seconds.

It emits `hold_started`, intermediate `hold_progress`, `hold_interrupted`, and `hold_completed`. Intermediate events never increment the completed-set count.

## Open-world supervision

Action-specific rules answer: **“Is the participant performing the currently prescribed action correctly?”** They are not a general activity classifier.

When sustained motion cannot be explained by the current action, the open-world layer returns a compact event such as:

```json
{
  "exercise": { "id": "knee_bends", "name": "Knee bends" },
  "observation": {
    "phase": "activity_hypothesis",
    "valid_count_increment": 0,
    "metrics": {
      "activity_supervisor": {
        "activity": "unknown_exercise",
        "behavior_pattern": "unexplained_repetitive_motion"
      }
    }
  }
}
```

`exercise.id` remains the prescribed action for controller routing. `unknown_exercise` means only that current evidence is not explained by that action. A broad `behavior_pattern` may describe inactivity, locomotion, or unexplained repeated motion, but does not name another exercise.

The controller then:

1. stops accepting counts;
2. requests one camera snapshot;
3. uses vision to distinguish another activity, rest, adjustment, framing/occlusion, or visible safety concern;
4. asks one brief question only if the image is insufficient;
5. requires a new `rep_started` or `hold_started` before counting resumes.

The camera and motion stream are treated as evidence about the same participant. Input provenance, file names, clip IDs, and replay metadata are removed at the perception boundary and are never sent to the controller or Realtime agent.

## Global safeguards

Before action-specific counting, the global monitor checks missing joints, sustained occlusion, low tracking confidence, persistent frame loss, timestamp gaps, stream stalls, out-of-order frames, tracked-person identity changes when provided upstream, and conservative possible-fall/recovery patterns.

Tracking problems and unexplained activity trigger vision. Possible-fall evidence freezes the set and requires explicit verbal confirmation; a still image alone cannot establish safety.

## Vision behavior

The browser requests camera permission when a session starts. Images are captured:

- once during global readiness;
- once during setup readiness for each new exercise;
- during an active set after mismatch, occlusion, low confidence, repeated frame loss, a stream fault, repeated invalid attempts, or a safety hypothesis.

Original JPEGs are stored locally under `logs/images/<local-session-id>/`. A separately compressed image is sent through the local relay when the configured Realtime route supports image input.

Vision may assess visible setup/activity. It cannot establish symptoms, illness clearance, actual resistance, repetition counts, hold duration, hidden contact, or stability over time.

## Manual motion demonstration

Entering `active_set` never starts a sequence automatically. The page displays **Motion input ready** and waits for the researcher.

### Default input

If no custom sequence is selected, click **Play motion** to use the prescription-matched compact input.

### Select an input

Open **Configure reconstruction clips and replay order**:

1. select a sequence from `output1`, `output2`, or `motion_test_data`;
2. inspect or edit the start/end interval;
3. choose 5 or 10 FPS;
4. optionally inject occlusion, low confidence, persistent frame loss, a stream gap, or startup delay;
5. click **Use now / replace pending**;
6. click **Play motion**.

For known compound recordings, the page proposes the interval matching the current prescribed action:

- `output1/back_extension_knee_bends`: knee bends at approximately **20–37 seconds**;
- `output2/heel_toe_standing_one_leg_stand`: the appropriate left/right one-leg interval.

The interval remains editable for robustness tests.

### Pause and switch

- **Pause motion** freezes joints while voice remains active; the participant may ask for the authoritative current count.
- **Resume motion** continues from the same frame.
- Selecting another sequence and clicking **Use now** during playback changes future input frames. The detector/controller are not told that a test file changed; they interpret the continuous sensor evidence.
- **Pause presentation** freezes motion and disables microphone upload so room discussion is not treated as participant speech.

## Run locally

Requirements: Node.js 20+, an XTY API key with Realtime access, and a WebRTC-capable browser.

Create `.env` in the project root:

```text
XTY_API_KEY=your_key
XTY_REALTIME_WS_URL=wss://svip.xty.app/v1/realtime
XTY_REALTIME_MODEL=gpt-realtime
XTY_REALTIME_PROTOCOL=auto
XTY_REALTIME_REASONING_EFFORT=medium

OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_HISTORY_TOKENS=6000
OPENAI_REALTIME_RETENTION_RATIO=0.8
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe

XTY_REALTIME_IMAGE_INPUT=true
PORT=3001
GVHMR_OUTPUT_ROOT=/absolute/path/to/the/folder-containing-output1-and-output2
```

Then:

```bash
npm install
npm start
```

Open [http://localhost:3001](http://localhost:3001), click **Start voice session**, and grant microphone/camera permission.

Notes:

- The API key stays on the local server and is never placed in browser JavaScript.
- `XTY_REALTIME_PROTOCOL=auto` uses the legacy schema for unversioned/1.x aliases and the modern schema for 2.x aliases.
- Reasoning effort accepts `low`, `medium`, or `high` when the selected protocol supports it.
- The page's voice selector applies to the next connection; choose a voice and click **New session**.
- If port 3001 is occupied, change `PORT` or stop the existing process.

Expected data layout:

```text
Otago/
  output1/
  output2/
  otago_v7_context_aware_motion/
```

## Prescription

The active two-action prescription is [`prescriptions/demo-prescription.json`](./prescriptions/demo-prescription.json).

`fast_demo_skip_opening_checks` defaults to `false`, preserving greeting, readiness, plan briefing, exercise setup, review, and wrap-up. The fast path remains available for isolated engineering tests but is not the v7 default.

Prescription replacement is accepted only before exercise begins. The controller—not the model—owns action order, support, dose, side, and completion count.

## Motion interfaces

See [`COLLABORATOR_INPUT.md`](./COLLABORATOR_INPUT.md) for the full contract. The demo accepts raw joint frames or compact semantic events.

### Raw joint frame

```json
{
  "type": "joint_frame",
  "timestamp_ms": 1789400000000,
  "frame_index": 42,
  "fps": 10,
  "person_id": "participant-a",
  "tracking_confidence": 0.94,
  "joints3d_global": [[0.0, 0.9, 0.0]]
}
```

`joints3d_global` must contain 24 standard-order SMPL joints as `[x, y, z]`. A named `joints` object is also accepted.

### Semantic event

```json
{
  "exercise": {
    "id": "knee_bends",
    "name": "Knee bends",
    "side": "bilateral",
    "rep_index": 2
  },
  "observation": {
    "phase": "rep_completed",
    "confidence": 0.95,
    "valid_count_increment": 1,
    "metrics": {
      "left_knee_deg": 136.2,
      "right_knee_deg": 138.1
    }
  },
  "assessment": {
    "status": "correct",
    "issues": [],
    "requires_response": false,
    "summary": "One valid knee-bend cycle completed."
  }
}
```

The perception boundary strips prerecorded-source provenance. Semantic events contain action evidence, not file or clip identity.

## Logs

Session JSON is saved under `logs/` when a session ends, restarts, finalizes, or fails. It includes conversation transcripts, controller state/outcomes, compact function records, client lifecycle events, and vision metadata/local paths.

Do not commit logs containing participant data. Archive or delete them according to the study's data-handling policy.

## Tests

```bash
npm test
npm run test:motion-robustness
```

Tests cover the complete two-action session, manual-only playback, five knee bends, left/right holds, authoritative progress, mismatch, inactivity, occlusion, low confidence, frame loss, gaps/stalls, visual escalation, safety lockout, and the Realtime relay.

## Key files

| File | Purpose |
|---|---|
| `server.mjs` | Local server, session API, logging, and relay entry point |
| `xty-realtime-relay.mjs` | Authenticated browser-to-XTY Realtime relay |
| `simplified-controller.mjs` | Authoritative compact session controller |
| `public/app.js` | Browser voice, camera, motion controls, and continuation logic |
| `public/gvhmr-motion.js` | Joint processing, action detectors, safeguards, and input playback |
| `public/open-world-activity.js` | Rolling-window unknown-activity supervision |
| `public/motion-schema.js` | Semantic normalization and provenance stripping |
| `prescriptions/demo-prescription.json` | Current week-8 two-action prescription |
| `instructions/` | Global and action-specific coaching rules |
| `scripts/run_motion_robustness.mjs` | End-to-end robustness evaluation |

## Current limitations

- Only knee bends and one-leg stand have action-specific detectors.
- Thresholds are prototype values tested on a small number of reconstructed sequences, not a clinical population.
- A still image cannot replace temporal motion evidence.
- Open-world supervision detects unexplained activity but does not identify every possible exercise.
- Camera and joint input are assumed to describe the same participant; production still needs upstream synchronization and identity handling.
- Realtime image/function support depends on the provider route behind the configured model alias.
