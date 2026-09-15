#!/usr/bin/env python3
"""Convert selected GVHMR joint streams into a small browser replay fixture.

The raw GVHMR folders remain the source of truth.  This exporter deliberately
reads only joints3d_global.npy: the 6,890-vertex mesh, rotations, and unchanged
frames are not needed by the two rule-based Otago detectors in this demo.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


SMPL_24 = [
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee",
    "spine2", "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot",
    "neck", "left_collar", "right_collar", "head", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hand", "right_hand",
]

SELECTED_JOINTS = [
    "pelvis", "left_hip", "right_hip", "left_knee", "right_knee",
    "left_ankle", "right_ankle", "left_foot", "right_foot", "neck",
]

SOURCE_FPS = 30.0


def compact_segment(
    joints: np.ndarray,
    *,
    segment_id: str,
    set_id: str,
    side: str,
    start_frame: int,
    end_frame: int,
    analysis_fps: float,
) -> dict:
    stride = round(SOURCE_FPS / analysis_fps)
    indices = list(range(start_frame, min(end_frame, len(joints)), stride))
    selected_indices = [SMPL_24.index(name) for name in SELECTED_JOINTS]
    frames = []
    for source_frame in indices:
        coordinates = joints[source_frame, selected_indices]
        frames.append({
            "source_frame": source_frame,
            "source_time_s": round(source_frame / SOURCE_FPS, 3),
            "joints": {
                name: [round(float(value), 5) for value in point]
                for name, point in zip(SELECTED_JOINTS, coordinates)
            },
        })
    return {
        "segment_id": segment_id,
        "set_id": set_id,
        "side": side,
        "source_frame_range": [start_frame, end_frame],
        "frames": frames,
    }


def load_joints(path: Path) -> np.ndarray:
    joints = np.load(path, mmap_mode="r")
    if joints.ndim != 3 or joints.shape[1:] != (24, 3):
        raise ValueError(f"Expected (T, 24, 3) joints at {path}; got {joints.shape}")
    if not np.isfinite(joints).all():
        raise ValueError(f"Non-finite joint coordinate found in {path}")
    return joints


def build(source_root: Path) -> dict:
    knee_source = source_root / "output1" / "back_extension_knee_bends" / "joints3d_global.npy"
    stand_source = source_root / "output2" / "heel_toe_standing_one_leg_stand" / "joints3d_global.npy"
    knee_joints = load_joints(knee_source)
    stand_joints = load_joints(stand_source)

    return {
        "schema_version": "1.0",
        "coordinate_system": "GVHMR global 3D coordinates; Y is vertical",
        "joint_schema": "SMPL-24",
        "selected_joints": SELECTED_JOINTS,
        "source_fps": SOURCE_FPS,
        "notes": [
            "Frames are downsampled from the 30 FPS GVHMR output.",
            "Only the ten joints required by the two detectors are retained.",
            "Source ranges isolate the named Otago movement from multi-action recordings.",
        ],
        "actions": {
            "knee_bends": {
                "clip_id": "gvhmr-output1-knee-bends",
                "source": "output1/back_extension_knee_bends/joints3d_global.npy",
                "analysis_fps": 10.0,
                "detector": {
                    "type": "knee_bends",
                    "down_threshold_deg": 140.0,
                    "return_threshold_deg": 158.0,
                    "minimum_depth_deg": 140.0,
                    "maximum_knee_asymmetry_deg": 18.0,
                    "maximum_trunk_lean_deg": 22.0,
                },
                # Frames 600:1110 contain the first five complete knee-bend cycles.
                "segments": [compact_segment(
                    knee_joints,
                    segment_id="knee-bends-first-five",
                    set_id="demo-five-reps",
                    side="bilateral",
                    start_frame=600,
                    end_frame=1110,
                    analysis_fps=10.0,
                )],
            },
            "one_leg_stand": {
                "clip_id": "gvhmr-output2-one-leg-stand",
                "source": "output2/heel_toe_standing_one_leg_stand/joints3d_global.npy",
                "analysis_fps": 5.0,
                "detector": {
                    "type": "one_leg_stand",
                    "minimum_lift_leg_ratio": 0.18,
                    "maximum_stance_drift_leg_ratio": 0.12,
                    "maximum_pelvis_sway_leg_ratio": 0.22,
                    "maximum_trunk_lean_deg": 20.0,
                    "hold_seconds": 10.0,
                },
                "segments": [
                    compact_segment(
                        stand_joints,
                        segment_id="left-foot-lifted-hold",
                        set_id="left-foot-lifted",
                        side="left foot lifted",
                        start_frame=1005,
                        end_frame=1395,
                        analysis_fps=5.0,
                    ),
                    compact_segment(
                        stand_joints,
                        segment_id="right-foot-lifted-hold",
                        set_id="right-foot-lifted",
                        side="right foot lifted",
                        start_frame=1425,
                        end_frame=1770,
                        analysis_fps=5.0,
                    ),
                ],
            },
        },
    }


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-root",
        type=Path,
        default=project_root.parent,
        help="Directory containing output1 and output2 (default: parent of project)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=project_root / "public" / "motion-data" / "gvhmr-demo.json",
    )
    args = parser.parse_args()

    payload = build(args.source_root.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
