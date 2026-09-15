#!/usr/bin/env python3
"""Create reproducible robustness sequences from the two recorded GVHMR clips."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


FPS = 30.0
JOINTS = {
    "left_knee": 4, "right_knee": 5, "left_ankle": 7, "right_ankle": 8,
    "left_foot": 10, "right_foot": 11,
}


def anchored(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    """Join recordings while removing the irrelevant global translation jump."""
    suffix = second.copy()
    suffix += first[-1, 0] - suffix[0, 0]
    return np.concatenate([first, suffix], axis=0)


def static_tail(frame: np.ndarray, seconds: float) -> np.ndarray:
    return np.repeat(frame[None, ...], round(seconds * FPS), axis=0)


def write_scenario(root: Path, name: str, joints: np.ndarray, description: str,
                   *, confidence: np.ndarray | None = None,
                   validity: np.ndarray | None = None,
                   timestamps: np.ndarray | None = None,
                   expected: str, startup_delay_ms: int = 0) -> None:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    joints = np.asarray(joints, dtype=np.float32)
    np.save(folder / "joints3d_global.npy", joints)
    np.save(folder / "timestamps_s.npy", np.asarray(timestamps if timestamps is not None else np.arange(len(joints)) / FPS, dtype=np.float64))
    np.save(folder / "tracking_confidence.npy", np.asarray(confidence if confidence is not None else np.ones(len(joints)), dtype=np.float32))
    np.save(folder / "joint_validity.npy", np.asarray(validity if validity is not None else np.ones((len(joints), 24), dtype=bool), dtype=bool))
    metadata = {
        "name": name,
        "description": description,
        "expected_supervisor_behavior": expected,
        "source_fps": FPS,
        "frame_count": int(len(joints)),
        "recommended_startup_delay_ms": int(startup_delay_ms),
        "derived_from": [
            "output1/back_extension_knee_bends/joints3d_global.npy",
            "output2/heel_toe_standing_one_leg_stand/joints3d_global.npy",
        ],
        "sidecars": {
            "timestamps_s.npy": "Per-frame source time; can encode a stream delay/gap.",
            "tracking_confidence.npy": "Per-frame upstream reconstruction confidence.",
            "joint_validity.npy": "Per-frame SMPL-24 visibility/validity mask.",
        },
    }
    (folder / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


def build(source_root: Path, output_root: Path) -> None:
    knee_all = np.load(source_root / "output1/back_extension_knee_bends/joints3d_global.npy")
    stand_all = np.load(source_root / "output2/heel_toe_standing_one_leg_stand/joints3d_global.npy")
    knee = knee_all[600:1110]
    knee_two = knee_all[600:816]
    one_leg = stand_all[1005:1395]
    one_leg_four = stand_all[1005:1128]

    write_scenario(output_root, "knee_two_reps_then_one_leg", anchored(knee_two, one_leg[:240]),
                   "Two valid knee bends followed by the recorded one-leg activity.",
                   expected="Accept two repetitions, then freeze counting and request activity clarification.")
    write_scenario(output_root, "one_leg_four_seconds_then_knee_bends", anchored(one_leg_four, knee[:270]),
                   "About four seconds of one-leg standing followed by recorded knee bends.",
                   expected="Interrupt/reset the hold, classify unexpected activity, and avoid a false hold completion.")
    write_scenario(output_root, "knee_two_reps_then_stop_12s", np.concatenate([knee_two, static_tail(knee_two[-1], 12)]),
                   "Two knee bends followed by twelve seconds without body motion.",
                   expected="Keep count at two and escalate sustained inactivity for clarification.")
    write_scenario(output_root, "one_leg_four_seconds_then_stop_12s", anchored(one_leg_four, static_tail(knee_all[600], 12)),
                   "A partial one-leg hold followed by twelve seconds in a static two-foot pose.",
                   expected="Reset the continuous hold and escalate inactivity without completing the set.")
    write_scenario(output_root, "wrong_for_knee_one_leg_only", one_leg,
                   "The one-leg recording is supplied while knee bends are prescribed.",
                   expected="Do not count knee bends; infer a likely wrong activity and request visual clarification.")
    write_scenario(output_root, "wrong_for_one_leg_knee_bends_only", knee,
                   "The knee-bend recording is supplied while a one-leg hold is prescribed.",
                   expected="Do not complete the hold; infer repetitive unexpected movement and clarify.")

    validity = np.ones((len(knee), 24), dtype=bool)
    start, end = round(len(knee) * .30), round(len(knee) * .48)
    validity[start:end, list(JOINTS.values())] = False
    write_scenario(output_root, "knee_lower_body_occlusion", knee,
                   "The recorded knee bends with lower-body joints unavailable in a sustained middle window.",
                   validity=validity, expected="Block invalid frames and escalate sustained tracking loss; never fabricate repetitions.")

    confidence = np.ones(len(one_leg), dtype=np.float32)
    start, end = round(len(one_leg) * .30), round(len(one_leg) * .48)
    confidence[start:end] = .25
    write_scenario(output_root, "one_leg_low_confidence", one_leg,
                   "The recorded one-leg hold with a sustained low-confidence reconstruction window.",
                   confidence=confidence, expected="Freeze temporal progress during low confidence and request tracking clarification.")

    keep = np.arange(len(knee)) % 4 != 0
    write_scenario(output_root, "knee_periodic_frame_drop", knee[keep],
                   "Every fourth frame is removed from the recorded knee-bend sequence.",
                   timestamps=np.arange(len(knee))[keep] / FPS,
                   expected="Tolerate intermittent loss and preserve valid repetition counting.")

    timestamps = np.arange(len(one_leg), dtype=np.float64) / FPS
    timestamps[len(timestamps) // 2:] += 2.0
    write_scenario(output_root, "one_leg_two_second_stream_gap", one_leg,
                   "The recorded one-leg hold with a two-second timestamp discontinuity halfway through.",
                   timestamps=timestamps,
                   expected="Detect the stream gap and prevent the missing time from counting toward the hold.")

    write_scenario(output_root, "knee_startup_delay_5s", knee,
                   "The valid knee-bend recording is withheld for five seconds before its first frame arrives.",
                   expected="The wall-clock no-frame watchdog should report startup silence; baseline detection begins only after frames arrive.",
                   startup_delay_ms=5000)

    readme = """# Motion robustness fixtures

These folders are deterministic derivatives of the two original 30 FPS SMPL-24 GVHMR recordings. Each scenario retains `joints3d_global.npy` and adds timestamps, tracking confidence, and joint-validity sidecars. They are research fixtures—not new participant recordings—and can be selected from the demo's raw-sequence menu.

The files intentionally cover action switching, stopping, persistent wrong activity, occlusion, low confidence, frame loss, and timestamp delay. See each `metadata.json` for the expected detector/supervisor behavior.
"""
    (output_root / "README.md").write_text(readme, encoding="utf-8")
    print(f"Wrote {len(list(output_root.glob('*/joints3d_global.npy')))} scenarios to {output_root}")


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, default=project_root / "motion_test_data")
    args = parser.parse_args()
    build(args.source_root.resolve(), args.output_root.resolve())


if __name__ == "__main__":
    main()
