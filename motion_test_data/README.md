# Motion robustness fixtures

These folders are deterministic derivatives of the two original 30 FPS SMPL-24 GVHMR recordings. Each scenario retains `joints3d_global.npy` and adds timestamps, tracking confidence, and joint-validity sidecars. They are research fixtures—not new participant recordings—and can be selected from the demo's raw-sequence menu.

The files intentionally cover action switching, stopping, persistent wrong activity, occlusion, low confidence, frame loss, and timestamp delay. See each `metadata.json` for the expected detector/supervisor behavior.
