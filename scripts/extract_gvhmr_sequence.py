#!/usr/bin/env python3
"""List or compact raw output1/output2 GVHMR joint sequences for browser replay."""

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
SELECTED = [
    "pelvis", "left_hip", "right_hip", "left_knee", "right_knee",
    "left_ankle", "right_ankle", "left_foot", "right_foot", "neck",
]
SOURCE_FPS = 30.0


def discover(root: Path, scenario_root: Path | None = None) -> list[dict]:
    sequences = []
    locations = [("output1", root / "output1"), ("output2", root / "output2")]
    if scenario_root is not None:
        locations.append(("motion_test_data", scenario_root))
    for output_name, output_dir in locations:
        if not output_dir.is_dir():
            continue
        for npy_path in sorted(output_dir.glob("*/joints3d_global.npy")):
            joints = np.load(npy_path, mmap_mode="r")
            if joints.ndim != 3 or joints.shape[1:] != (24, 3):
                continue
            sequence_id = f"{output_name}/{npy_path.parent.name}"
            metadata_path = npy_path.parent / "metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.is_file() else {}
            source_fps = float(metadata.get("source_fps", SOURCE_FPS))
            timestamps_path = npy_path.parent / "timestamps_s.npy"
            duration = float(np.load(timestamps_path, mmap_mode="r")[-1]) if timestamps_path.is_file() and len(joints) else float(joints.shape[0] / source_fps)
            sequences.append({
                "id": sequence_id,
                "output": output_name,
                "name": npy_path.parent.name,
                "frame_count": int(joints.shape[0]),
                "source_fps": source_fps,
                "duration_seconds": round(duration, 2),
                "description": metadata.get("description", ""),
                "recommended_startup_delay_ms": int(metadata.get("recommended_startup_delay_ms", 0)),
            })
    return sequences


def extract(root: Path, scenario_root: Path | None, sequence_id: str, start_s: float, end_s: float, analysis_fps: float) -> dict:
    allowed = {item["id"]: item for item in discover(root, scenario_root)}
    if sequence_id not in allowed:
        raise ValueError(f"Unknown GVHMR sequence: {sequence_id}")
    output_name, folder = sequence_id.split("/", 1)
    base = scenario_root if output_name == "motion_test_data" else root / output_name
    source_dir = base / folder
    source = source_dir / "joints3d_global.npy"
    joints = np.load(source, mmap_mode="r")
    source_fps = float(allowed[sequence_id].get("source_fps", SOURCE_FPS))
    start_frame = max(0, min(len(joints) - 1, round(start_s * source_fps)))
    end_frame = max(start_frame + 1, min(len(joints), round(end_s * source_fps)))
    stride = max(1, round(source_fps / analysis_fps))
    timestamps_path = source_dir / "timestamps_s.npy"
    confidence_path = source_dir / "tracking_confidence.npy"
    validity_path = source_dir / "joint_validity.npy"
    timestamps = np.load(timestamps_path, mmap_mode="r") if timestamps_path.is_file() else None
    confidence = np.load(confidence_path, mmap_mode="r") if confidence_path.is_file() else None
    validity = np.load(validity_path, mmap_mode="r") if validity_path.is_file() else None
    indices = range(start_frame, end_frame, stride)
    selected_indices = [SMPL_24.index(name) for name in SELECTED]
    frames = []
    for source_frame in indices:
        coordinates = joints[source_frame, selected_indices]
        valid = np.isfinite(coordinates).all(axis=1)
        if validity is not None:
            valid &= np.asarray(validity[source_frame, selected_indices], dtype=bool)
        frame = {
            "source_frame": int(source_frame),
            "source_time_s": round(float(timestamps[source_frame] if timestamps is not None else source_frame / source_fps), 3),
            "joints": {
                name: [round(float(value), 5) for value in point]
                for name, point, is_valid in zip(SELECTED, coordinates, valid) if is_valid
            },
        }
        if confidence is not None:
            frame["tracking_confidence"] = round(float(confidence[source_frame]), 3)
        frames.append(frame)
    if not frames:
        raise ValueError("Selected interval contains no finite frames")
    safe_id = sequence_id.replace("/", "-").replace("_", "-")
    return {
        "schema_version": "1.0",
        "coordinate_system": "GVHMR global 3D coordinates; Y is vertical",
        "joint_schema": "SMPL-24",
        "selected_joints": SELECTED,
        "source_fps": source_fps,
        "notes": ["Generated on demand from a raw output1/output2 joints3d_global.npy sequence."],
        "actions": {
            "source_sequence": {
                "name": allowed[sequence_id]["name"],
                "clip_id": f"raw-{safe_id}-{start_frame}-{end_frame}",
                "source": f"{sequence_id}/joints3d_global.npy",
                "analysis_fps": analysis_fps,
                "segments": [{
                    "segment_id": f"{safe_id}-{start_frame}-{end_frame}",
                    "set_id": "source-clip",
                    "side": "source recording",
                    "source_frame_range": [start_frame, end_frame],
                    "frames": frames,
                }],
            }
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--scenario-root", type=Path)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--sequence-id")
    parser.add_argument("--start-s", type=float, default=0)
    parser.add_argument("--end-s", type=float, default=20)
    parser.add_argument("--analysis-fps", type=float, default=5)
    args = parser.parse_args()
    root = args.source_root.resolve()
    if args.list:
        print(json.dumps({"sequences": discover(root, args.scenario_root)}, separators=(",", ":")))
        return
    if not args.sequence_id:
        raise ValueError("--sequence-id is required")
    print(json.dumps(extract(root, args.scenario_root, args.sequence_id, args.start_s, args.end_s, args.analysis_fps), separators=(",", ":")))


if __name__ == "__main__":
    main()
