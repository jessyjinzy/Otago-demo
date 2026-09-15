# V7 motion-supervision design

## Why finite exercise rules remain—but are not enough

Action-specific rules are useful restrictions because they are interpretable, inexpensive at 5–10 FPS, tied to the PT prescription, and easy to validate. They should determine narrow facts such as whether a knee-bend cycle crossed the prescribed depth or whether a one-leg hold remained stable for ten seconds. They should not be asked to explain every possible human behavior.

V7 therefore surrounds them with three safeguards:

```text
SMPL-24 joint frame
  ├─ global frame/activity monitor
  │    tracking loss · possible fall
  ├─ open-world activity supervisor (rolling 4-second window)
  │    generic features · ranked activity hypotheses
  └─ prescribed-action temporal detector
       phase · progress · invalid attempt · completion
                    ↓
          deterministic controller supervisor
       count · streaks · escalation · safety lock
                    ↓
     silent / brief cue / structured vision / voice / stop
```

## Intermediate events

- `rep_started`: the prescribed repetition has entered its active phase; count remains unchanged.
- `hold_started`: a stable timed hold has begun.
- `hold_progress`: emitted every two valid seconds; it updates controller awareness without creating a voice response.
- `hold_interrupted`: the timer reset because the lifted foot, stance foot, pelvis sway, or trunk lean violated its rule.
- `rep_completed` / `hold_completed`: the only events that can increment the authoritative target.

## Escalation policy

1. Healthy progress: silent; the controller remains aware.
2. First invalid attempt: one concise action-specific cue.
3. Second consecutive invalid attempt, tracking uncertainty, or unexplained activity: one still image is requested to inspect visible form, support, framing, or whether the participant changed activities. The image is returned through `submit_visual_observation`, not free-form prose.
4. Continued uncertainty after vision: ask one short verbal confirmation about comfort, intent, pause, retry, or skip.
5. Possible fall hypothesis: freeze counting and require an explicit responsiveness/safety check. A confirmed fall, injury, instability, or explicit safety concern enters the deterministic stop state.

The policy intentionally avoids sending every frame to Realtime. Vision is a single-frame clarification mechanism and cannot establish repetition count, continuous hold time, recovery dynamics, contact hidden by occlusion, pain, dizziness, or clinical clearance.

## Current boundary

The possible-fall rule is a conservative demo guard based on rapid normalized pelvis descent plus large trunk lean. It is not a clinically validated fall detector, so it freezes the stream but does not itself assert that a fall occurred. The controller accepts no further count until `perception_check_result` records `safe_to_continue`, `needs_rest`, or `confirmed_safety_concern`.

When the prescribed detector cannot explain the last six seconds, `OpenWorldActivitySupervisor` summarizes a rolling four-second joint window. A candidate must also remain stable for at least 1.2 seconds before it emits. Its normalized features include pelvis path and displacement, foot path/displacement and peak speed, pelvis vertical range and height over the ankles, bilateral knee-angle range, vertical turning points, trunk lean/range, and motion irregularity. It separates inactivity, unexpected locomotion, repetitive but nonmatching motion, unexpected sitting, unexplained movement, and a conservative unstable-recovery hypothesis. Each output includes ranked alternatives and a recommended clarification; these remain hypotheses rather than hard labels.

A detector phase alone is not proof of continuing progress. Only discrete `rep_*` and `hold_*` milestones refresh the expected-action evidence timer, so a detector stuck indefinitely in `lowering` cannot hide a different activity. Valid knee-bend and one-leg fixture streams are regression-tested not to trigger this supervisor, while feeding the one-leg recording into the knee-bend detector is regression-tested to trigger clarification.

An emitted open-world hypothesis disables counting immediately but does not hard-stop replay. The controller requests one purpose-specific still: full-body/location for locomotion, expected action/support for repetitive motion, posture/intent for sitting or inactivity, and stability/support for unstable recovery. The still is classified into a fixed schema containing activity, calibrated confidence, body visibility, expected-exercise visibility, safety flag, and concrete visible evidence. Confidence below 0.6 falls back to one short intent question. Even a clear still of the expected pose cannot prove temporal execution, so counting remains disabled until the joint detector observes a new `rep_started` or `hold_started` milestone. The controller—not the model—owns these gates.

If the same unexplained activity persists, the supervisor re-emits only after an eight-second cooldown rather than on every frame. The first persistent hypothesis requests one image; a later unchanged hypothesis escalates to one short intent question instead of repeatedly taking photographs. Fresh prescribed-action evidence clears this escalation memory.

The supervisor still cannot reliably distinguish every open-world action from one still plus sparse joints. Dynamic identity, fall confirmation, pain, dizziness, and intent require temporal evidence or participant speech. The rules and thresholds are engineering defaults that require evaluation on multiple participants, camera views, occlusions, and reconstruction failures before any clinical interpretation. This version therefore exposes uncertainty and fuses evidence instead of pretending those cases are solved.

The raw-frame gate also rejects out-of-order timestamps, stream gaps, sustained low tracking confidence, missing required joints, and an unexpected `person_id` change before an exercise-specific detector can count the frame.

A separate 2.5-second wall-clock watchdog is armed whenever recorded replay or an external joint stream is expected. Unlike source-timestamp rules, it can detect that no frame arrived at all. It emits one `stream_stalled` uncertainty event, freezes counting through the controller, and requests multimodal clarification. Intentional presentation/motion pause suspends the watchdog, so a researcher pausing the demo does not create a false sensor alert. Recovery still requires a fresh temporal action milestone before counting resumes.

## Raw-sequence replay and robustness control

The researcher UI can enumerate and crop the existing `output1/output2/**/joints3d_global.npy` recordings directly. A small local Python helper memory-maps the chosen `(T,24,3)` file and returns only pelvis, neck, and bilateral hip/knee/ankle/foot coordinates at the selected 5 or 10 FPS rate. The browser then computes detector features and semantic events online exactly as it does for the default fixture.

An ordered replay queue assigns one chosen clip to each successive prescribed `active_set`. The selected recording may intentionally be a different movement from the expected exercise. The expected action detector is not changed, which is important: unexplained motion must remain unexplained rather than being silently relabeled. Optional fault transforms can remove lower-body joints, reduce confidence, drop frames, introduce a timestamp gap, or delay stream onset. These are deterministic engineering stressors for the supervision paths, not substitutes for naturally corrupted reconstruction data.
