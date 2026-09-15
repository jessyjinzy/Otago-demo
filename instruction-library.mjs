import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const instructionDir = resolve(rootDir, "instructions");

const actionFiles = Object.freeze({
  standing_posture_and_three_deep_breaths: "warm-up/standing-posture-and-three-deep-breaths.md",
  head_movements: "warm-up/head-movements.md",
  neck_movements: "warm-up/neck-movements.md",
  trunk_movements: "warm-up/trunk-movements.md",
  ankle_movements: "warm-up/ankle-movements.md",
  back_extension: "warm-up/back-extension.md",
  front_knee_strengthening: "strength/front-knee-strengthening.md",
  side_hip_strengthening: "strength/side-hip-strengthening.md",
  back_knee_strengthening: "strength/back-knee-strengthening.md",
  calf_raises: "strength/calf-raises.md",
  toe_raises: "strength/toe-raises.md",
  knee_bends: "balance/knee-bends.md",
  backwards_walking: "balance/backwards-walking.md",
  sideways_walking: "balance/sideways-walking.md",
  heel_toe_stand: "balance/heel-toe-stand.md",
  heel_toe_walking: "balance/heel-toe-walking.md",
  heel_toe_walking_backwards: "balance/heel-toe-walking-backwards.md",
  one_leg_stand: "balance/one-leg-stand.md",
  heel_walking: "balance/heel-walking.md",
  toe_walking: "balance/toe-walking.md",
  sit_to_stand: "balance/sit-to-stand.md",
  walking_and_turning: "balance/walking-and-turning.md",
  stair_walking: "balance/stair-walking.md",
});

const commonFiles = Object.freeze({
  warm_up: "warm-up/common-rules.md",
  strength: "strength/common-rules.md",
  balance: "balance/common-rules.md",
});

const cache = new Map();

export function getSystemInstruction() {
  return readInstruction("system-prompt-compact.md");
}

export function getActionInstruction(action) {
  if (!action) return "";
  const file = actionFiles[action.id];
  if (!file) {
    return "No action-specific instruction file is mapped. Do not invent movement rules; pause and request a corrected prescription.";
  }
  const category = action.category === "warm_up" ? "warm_up" : action.category;
  const commonFile = commonFiles[category];
  const common = commonFile ? readInstruction(commonFile) : "";
  return `${common}\n\n${readInstruction(file)}`.trim();
}

export function listSupportedActionIds() {
  return Object.keys(actionFiles);
}

function readInstruction(relativePath) {
  if (!cache.has(relativePath)) {
    cache.set(relativePath, readFileSync(resolve(instructionDir, relativePath), "utf8").trim());
  }
  return cache.get(relativePath);
}
