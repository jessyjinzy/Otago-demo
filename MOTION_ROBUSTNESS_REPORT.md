# Otago v7 Motion Robustness Report

**Test date:** 2026-09-14  
**Scope:** `knee_bends` and `one_leg_stand` detectors, global/open-world motion supervision, and deterministic controller reactions.  
**Current result:** 19/19 engineering scenarios pass, including two asynchronous startup-silence tests at the replay/live-stream boundary.

## 1. Data and method

The test harness reads the existing raw GVHMR arrays rather than inventing a separate skeleton fixture:

- `output1/back_extension_knee_bends/joints3d_global.npy`
- `output2/heel_toe_standing_one_leg_stand/joints3d_global.npy`
- `output1/backwards_walking_heel_toe_walking_forwards_backwards/joints3d_global.npy`, used as a real different-activity input

The target windows are the same ones used by the demo:

- Knee bends: source frames 600–1110, reduced from 30 FPS to 10 FPS (170 frames).
- One-leg stand, left foot lifted: frames 1005–1395 at 5 FPS (65 frames).
- One-leg stand, right foot lifted: frames 1425–1770 at 5 FPS (58 frames).

For cascaded tests, a prefix of the correct recording is followed by a real walking or static-pose sequence. The second sequence is translated so its first pelvis coordinate matches the previous sequence's last pelvis coordinate. This removes an artificial splice jump; timestamps remain continuous. Fault tests remove lower-body joints, set low confidence, drop every fourth frame, insert a two-second timestamp gap, or model five seconds with no incoming frame.

Each frame runs through the same local path used by the page:

```text
raw GVHMR joints
→ action-specific temporal detector
→ global frame gate + open-world supervisor
→ semantic motion event
→ deterministic controller count and attention policy
```

When the controller requests vision, the harness injects a structured ground-truth visual label for the known test condition and records the controller's next action. This tests the **motion-to-agent policy**, not GPT's real image-classification accuracy or final spoken wording. No Realtime API call is made.

## 2. Results: knee bends

| ID | Input condition | Count/result | Supervisor and agent-policy reaction | Verdict |
|---|---|---:|---|---|
| KB-01 | Original five knee bends | 5/5 | No false alert | PASS |
| KB-02 | Two correct reps → real walking | 2 accepted | `unknown_exercise` (`behavior_pattern: unexpected_locomotion`) after about 6 seconds; counting disabled; vision clarification | PASS |
| KB-03 | Two correct reps → 12 seconds standing still | 2 accepted | `inactive_present`; counting disabled; vision → resume/rest cue | PASS |
| KB-04 | One-leg recording for entire knee-bend set | 0 accepted | Detector briefly entered `rep_started`, but never counted; open-world clarification at 6 seconds; vision → wrong-exercise cue | PASS |
| KB-05 | Sustained lower-body occlusion | 4/5 | `tracking_lost`; corrupted frames blocked; vision → framing cue | PASS, conservative |
| KB-06 | Sustained confidence 0.25 | 4/5 | `tracking_unreliable`; corrupted frames blocked; vision → tracking/framing cue | PASS, conservative |
| KB-07 | Every fourth frame removed | 5/5 | No false alert | PASS |
| KB-08 | Two-second timestamp gap | Detector found 5; controller accepted 4 | One `stream_gap`; vision requested; progress during uncertainty was not accepted | PASS, conservative |
| KB-09 | No frame before delayed replay begins | 0 fabricated | Wall-clock `stream_stalled`; counting disabled; clarification path opened | PASS |

## 3. Results: one-leg stand

| ID | Input condition | Count/result | Supervisor and agent-policy reaction | Verdict |
|---|---|---:|---|---|
| OLS-01 | Original left-foot-lifted hold | 1/1 | `hold_started`, periodic `hold_progress`, then `hold_completed`; no false alert | PASS |
| OLS-10 | Original right-foot-lifted hold | 1/1 | Same correct temporal sequence | PASS |
| OLS-02 | Four valid seconds → real walking | 0 accepted | Immediate `hold_interrupted`; later `unknown_exercise` (`behavior_pattern: unexpected_locomotion`); vision clarification | PASS |
| OLS-03 | Four valid seconds → two-foot stance for 12 seconds | 0 accepted | `hold_interrupted`; later `inactive_present`; vision → rest/resume cue | PASS |
| OLS-04 | Knee-bend recording for entire one-leg set | 0 accepted | `unknown_exercise` (`behavior_pattern: unexplained_repetitive_motion`) at 6 seconds; vision clarification | PASS |
| OLS-05 | Sustained lower-body occlusion | 0 accepted | `tracking_lost`; hold reset; vision → framing cue | PASS, conservative |
| OLS-06 | Sustained confidence 0.25 | 0 accepted | `tracking_unreliable`; hold reset; vision → tracking cue | PASS, conservative |
| OLS-07 | Every fourth frame removed | 1/1 | Timestamp-based timer preserves the real ten-second hold | PASS |
| OLS-08 | Two-second timestamp gap | 0 accepted | One `stream_gap`; temporal continuity broken and hold reset; vision requested | PASS, conservative |
| OLS-09 | No frame before delayed replay begins | 0 fabricated | Wall-clock `stream_stalled`; counting disabled; clarification path opened | PASS |

## 4. Important findings

### What is working

1. **No false completion under cross-action input.** One-leg motion does not become a knee-bend count, and knee bends do not complete a one-leg hold.
2. **Correct-then-wrong and correct-then-stop are handled.** Previously accepted progress remains, later activity does not add false progress, and the controller requests targeted visual clarification.
3. **The controller reacts rather than merely displaying a label.** An open-world event disables counting, requests vision, and produces a cue based on the visual result. Counting resumes only after a new temporal `rep_started` or `hold_started` event.
4. **Moderate frame loss is tolerated.** Removing 25% of frames does not change knee-bend counts or the one-leg hold result.
5. **Sustained corruption is conservative.** Occlusion, low confidence, and a large timestamp gap prevent questionable evidence from completing the prescription.

### Problems discovered and fixed during testing

1. The one-leg timer previously added a fixed `1/FPS` per received frame. It now integrates actual source timestamps, with a bounded continuity rule. This fixes false failure when every fourth frame is missing.
2. Tracking loss previously caused a second, misleading `stream_gap` alert when valid joints returned. Transport arrival time and last valid pose time are now tracked separately, so recovery produces one tracking alert rather than two interventions.
3. A wrong action could push a detector into `lowering` indefinitely. A phase label alone no longer refreshes expected-action evidence; only discrete repetition/hold milestones do.

## 5. Remaining limitations

### A. No-frame startup/stall watchdog — implemented at the stream boundary

The open-world feature supervisor remains frame-driven, but the replay/live-stream adapter now arms a separate wall-clock watchdog when `active_set` expects frames and refreshes it on every frame:

- short silence: remain silent;
- 2.5 seconds without a frame: emit one `stream_stalled` uncertainty event and disable counting;
- the controller routes the event to visual/voice clarification rather than misclassifying it as participant inactivity;
- intentional pause disables the watchdog;
- recovery requires a fresh temporal action start before restoring counting.

The robustness command now combines synchronous frame-sequence tests with asynchronous boundary-watchdog tests so the absence of input is represented by real elapsed wall time.

### B. One participant and one reconstruction per action

Passing the baseline proves consistency with these recordings, not population robustness. Thresholds still need leave-one-subject-out testing across body sizes, support levels, clothing, camera viewpoints, speed, partial range, and naturally occurring GVHMR errors.

### C. Open-world labels remain broad

The supervisor can determine that motion is locomotion, repetitive but nonmatching, inactive, or unstable-looking. It does not identify every alternative Otago exercise. That is intentional for safety, but evaluation should measure false intervention rate and time-to-detection.

### D. Actual vision and speech behavior were not measured here

The harness injects the correct structured visual label. A separate online evaluation must test whether the configured Realtime model correctly interprets occlusion, wrong exercise, rest, and leaving the frame, and whether its spoken cue follows the controller instruction without delay or repetition.

## 6. Recommended next evaluation

1. Measure the wall-clock watchdog's false-alert rate and recovery latency with the real reconstruction transport.
2. Record at least 5–10 participants per action, including deliberately shallow/asymmetric knee bends and unstable/brief one-leg attempts.
3. Evaluate separately: repetition/hold accuracy, false count rate, anomaly detection latency, false intervention rate, visual clarification accuracy, and end-to-end time to an appropriate spoken response.
4. Treat thresholds as PT-reviewable configuration, not universal constants.

## 7. Reproduce

From the v7 project folder:

```bash
npm run test:motion-robustness
```

If `output1` and `output2` are not beside the v7 folder, set `GVHMR_OUTPUT_ROOT` to their common parent first. The command prints the full machine-readable results as JSON.
