# Motion-perception input contract

The camera/RF/4D pipeline should keep raw video, mesh, and high-rate trajectories locally. V7 supports two boundaries: send standard-order SMPL-24 `joints3d_global` frames to the local browser at 5–10 FPS and let its detector create events, or keep detection in the collaborator pipeline and send compact semantic events. Raw joints remain local and are never forwarded to the language model.

For the raw-frame boundary, send one WebSocket JSON message per frame with `type: "joint_frame"`, `timestamp_ms` or `source_time_s`, `fps`, and a `(24,3)` `joints3d_global` array. Also send `tracking_confidence` and a stable `person_id` when the reconstruction system exposes them. The browser automatically suspends recorded replay while this stream is connected. For the semantic boundary, send an event when a phase changes, a repetition/trial completes, the assessment changes, tracking becomes unreliable, or a safety-relevant event appears.

The motion module supplies evidence. It does not decide whether the voice agent should speak, change state, or alter the PT prescription.

## Transport

For the demo, serve one UTF-8 JSON object per message from a local WebSocket, for example `ws://localhost:8765`, then enter that URL in the page. Alternatively:

```js
window.otago.pushMotionEvent(event);
```

Start the voice session first. The page normalizes compact and canonical input formats.

## Canonical event

```json
{
  "schema_version": "1.0",
  "event_id": "evt-000042",
  "timestamp_ms": 1787491200123,
  "session_id": "deidentified-session-001",
  "exercise": {
    "id": "sit_to_stand",
    "name": "Sit to stand",
    "side": "not_applicable",
    "rep_index": 4
  },
  "observation": {
    "phase": "rep_completed",
    "confidence": 0.94,
    "clip_id": "clip-001-004",
    "metrics": {
      "chair_contact": true,
      "full_stand_detected": true,
      "hand_support": "right_hand_on_chair"
    }
  },
  "assessment": {
    "status": "needs_correction",
    "summary": "Observed hand support differs from the current prescribed set.",
    "issues": [
      {
        "code": "incorrect_hand_support",
        "severity": "moderate",
        "confidence": 0.91,
        "summary": "Right-hand support was detected; compare this with the prescription."
      }
    ]
  }
}
```

Allowed statuses are `correct`, `needs_correction`, `safety_concern`, and `uncertain`. Severity is one of `info`, `low`, `moderate`, `high`, or `critical`.

## Required behavior by state

- In `set_readiness`, report static starting evidence for a new exercise: posture, equipment/support, clear visibility, and unsafe setup when observable. A same-exercise side switch does not re-enter this state.
- In `active_set`, report valid repetitions, hold/step completion, correctable deviations, recoveries, uncertainty, and safety events. Routine correction stays inside the active set.
- For every semantic completion event, include `observation.valid_count_increment` (normally `1`; use `0` for invalid, uncertain, or non-completion evidence). GPT submits the generic `motion_observation` event, but only the simplified controller's returned count is authoritative.
- For `safety_concern`, include a concise factual reason such as `near_fall`, `actual_fall`, `unexpected_support_grab`, or `repeated_instability`. The agent/controller will stop the session pathway.
- If a key landmark, support surface, foot contact, or walking trajectory is occluded, emit `uncertain`; do not manufacture a correctness label.

## High-priority Otago measurements

The general pose pipeline is not enough for these actions; return the relevant observable evidence and confidence:

| Action | Needed evidence |
| --- | --- |
| Sit to stand | chair contact → full stand → controlled return to chair; prescribed 2H/1H/no-hand assistance |
| Front-knee strengthening | prescribed side, knee extension-return, stable thigh/pelvis, controlled lowering, ankle weight/support only if reliably observed |
| Side-hip strengthening | lateral leg abduction, foot forward, knee straight, stable pelvis/trunk, side order |
| Calf/toe raises | bilateral heel or forefoot elevation, contact of the opposite foot segment, controlled lowering, prescribed support |
| Heel-toe stand/walking | near-tandem heel-to-toe placement, front-foot side, hold/step count, recovery versus unsafe grab |
| One-leg stand | lifted-foot clearance, stance-foot continuity, hold duration, hand contact/recovery/near fall |
| Walking and turning | two connected clockwise/counter-clockwise lobes forming a figure-eight, center crossing, turn stability |
| Stair walking | explicit prescription enablement, step direction/count, handrail contact, supervision signal; stop on missed step or loss of safe sensing |

## What the perception collaborator should provide

1. Stable session/clip IDs and synchronized millisecond timestamps.
2. Exercise ID, phase, side/direction, and rep/step/trial index.
3. Confidence for each conclusion, not only a label.
4. Clinically interpretable metrics (contacts, trajectories, support, temporal phase), not only a latent embedding or MPJPE.
5. Issue code, severity, and factual summary.
6. A documented coordinate system, joint set, frame rate, and missing-data convention.
7. Raw assets stored separately and referenced by `clip_id`; do not send direct identifiers or raw participant data to this demo.
