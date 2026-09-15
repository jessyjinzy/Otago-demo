import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const workspaceDir = "/Users/jessyjin/Documents/Upenn26/otago_v6_work";
const SKILL_DIR = "/Users/jessyjin/.codex/plugins/cache/openai-primary-runtime/presentations/26.905.11957/skills/presentations";
const buildDir = path.join(workspaceDir, ".ppt-build");
const finalPath = path.join(workspaceDir, "presentation_output", "Otago_Motion_Interface_Briefing_v2.pptx");
const pythonExecutable = "/Users/jessyjin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const FONT = "Helvetica Neue";

const c = {
  ink: "#102018", muted: "#5B6B62", green: "#175B38", mint: "#DDEEE3",
  pale: "#F3F7F3", amber: "#D68A22", amberPale: "#FFF2DC", white: "#FFFFFF",
  line: "#B8C8BE", navy: "#102A33", red: "#A94038",
};

const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });

function box(slide, x, y, w, h, fill, geometry = "rect") {
  return slide.shapes.add({ geometry, position: { left: x, top: y, width: w, height: h }, fill, line: { fill: "none", width: 0 } });
}

function tx(slide, value, x, y, w, h, options = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox", position: { left: x, top: y, width: w, height: h },
    fill: options.fill ?? "none", line: { fill: "none", width: 0 },
  });
  shape.text = value;
  shape.text.style = {
    typeface: FONT, fontSize: options.size ?? 22, bold: options.bold ?? false,
    color: options.color ?? c.ink, alignment: options.align ?? "left",
    verticalAlignment: options.valign ?? "top", autoFit: "shrinkText",
  };
  return shape;
}

function heading(slide, value, section) {
  tx(slide, section.toUpperCase(), 70, 31, 1140, 22, { size: 13, bold: true, color: c.green });
  tx(slide, value, 70, 58, 1140, 52, { size: 34, bold: true });
}

function footer(slide, index) {
  box(slide, 70, 681, 1140, 1, c.line);
  tx(slide, "Otago motion interface prototype", 70, 688, 400, 16, { size: 10, color: c.muted });
  tx(slide, String(index).padStart(2, "0"), 1165, 688, 45, 16, { size: 10, bold: true, color: c.muted, align: "right" });
}

function styleTable(table, rows, columns, headerColor = c.green) {
  table.borders.assign({ style: "solid", fill: c.line, width: 1 });
  table.cells.block({ row: 0, column: 0, rowCount: 1, columnCount: columns }).assign({
    fill: headerColor,
    textStyle: { typeface: FONT, fontSize: 14, bold: true, color: c.white },
    margins: { left: 10, right: 10, top: 6, bottom: 6 },
  });
  if (rows > 1) {
    table.cells.block({ row: 1, column: 0, rowCount: rows - 1, columnCount: columns }).assign({
      fill: c.white,
      textStyle: { typeface: FONT, fontSize: 14, color: c.ink },
      margins: { left: 10, right: 10, top: 5, bottom: 5 },
    });
  }
}

// Slide 1
{
  const s = p.slides.add();
  s.background.fill = c.pale;
  box(s, 0, 0, 28, 720, c.green);
  tx(s, "OTAGO HOME EXERCISE COACH", 82, 102, 900, 26, { size: 15, bold: true, color: c.green });
  tx(s, "Motion interface\nfor realtime coaching", 80, 160, 950, 145, { size: 49, bold: true });
  tx(s, "Recorded GVHMR motion with online action judgment", 84, 338, 830, 50, { size: 25, color: c.muted });
  box(s, 84, 472, 880, 2, c.line);
  tx(s, "Prototype actions", 84, 505, 220, 28, { size: 15, bold: true, color: c.green });
  tx(s, "Knee bends", 302, 498, 270, 40, { size: 25, bold: true });
  tx(s, "One-leg stand", 625, 498, 310, 40, { size: 25, bold: true });
  tx(s, "Real reconstructed coordinates\nShared semantic motion interface", 84, 590, 740, 60, { size: 18, color: c.muted });
  s.speakerNotes.textFrame.setText("Implementation sources: public/gvhmr-motion.js; scripts/prepare_gvhmr_demo.py; public/motion-data/gvhmr-demo.json.");
}

// Slide 2
{
  const s = p.slides.add();
  s.background.fill = c.white;
  heading(s, "Recorded motion, online judgment", "Data path");
  tx(s, "PREPARED BEFORE THE DEMO", 70, 139, 520, 24, { size: 14, bold: true, color: c.green });
  tx(s, "COMPUTED DURING THE DEMO", 680, 139, 530, 24, { size: 14, bold: true, color: c.amber });
  box(s, 70, 176, 530, 380, c.pale, "roundRect");
  box(s, 680, 176, 530, 380, c.amberPale, "roundRect");
  const offline = [
    ["01", "GVHMR reconstruction", "30 FPS global SMPL-24 coordinates"],
    ["02", "Action interval selection", "Two recorded clips cropped to the target motion"],
    ["03", "Compact joint frames", "10 joints retained and stored at 5 or 10 FPS"],
  ];
  const online = [
    ["04", "Timed frame release", "Recorded coordinates replayed at 1× source time"],
    ["05", "Feature calculation", "Angles, drift, sway and duration update per frame"],
    ["06", "Semantic event generation", "Counting and result JSON produced live"],
  ];
  offline.forEach(([n, h, b], i) => {
    const y = 209 + i * 106;
    tx(s, n, 96, y, 50, 26, { size: 14, bold: true, color: c.green });
    tx(s, h, 154, y - 4, 400, 30, { size: 21, bold: true });
    tx(s, b, 154, y + 34, 390, 42, { size: 16, color: c.muted });
  });
  online.forEach(([n, h, b], i) => {
    const y = 209 + i * 106;
    tx(s, n, 706, y, 50, 26, { size: 14, bold: true, color: c.amber });
    tx(s, h, 764, y - 4, 400, 30, { size: 21, bold: true });
    tx(s, b, 764, y + 34, 390, 42, { size: 16, color: c.muted });
  });
  box(s, 70, 583, 1140, 55, c.navy, "roundRect");
  tx(s, "The recording is fixed. Feature calculation, temporal detection, counting and result JSON run online.", 94, 598, 1090, 30, { size: 20, bold: true, color: c.white, align: "center" });
  footer(s, 2);
  s.speakerNotes.textFrame.setText("Joint selection and downsampling are preprocessing steps. The browser calculates features and semantic results online for each released real frame. Sources: scripts/prepare_gvhmr_demo.py lines 18–148; public/gvhmr-motion.js lines 26–346.");
}

// Slide 3
{
  const s = p.slides.add();
  s.background.fill = c.white;
  heading(s, "Knee-bend detector", "Action rule 1");
  tx(s, "Joints", 70, 139, 110, 24, { size: 14, bold: true, color: c.green });
  tx(s, "bilateral hip, knee and ankle; pelvis and neck", 175, 134, 800, 34, { size: 23, bold: true });
  box(s, 70, 183, 1140, 2, c.line);
  tx(s, "Cycle", 70, 215, 100, 24, { size: 14, bold: true, color: c.green });
  tx(s, "≤ 140° descent", 175, 208, 250, 38, { size: 23, bold: true });
  tx(s, "then", 437, 212, 62, 30, { size: 17, color: c.muted, align: "center" });
  tx(s, "≥ 158° return", 510, 208, 250, 38, { size: 23, bold: true });
  tx(s, "one repetition candidate", 790, 208, 350, 38, { size: 23, bold: true, color: c.green });
  tx(s, "Restrictions", 70, 273, 140, 24, { size: 14, bold: true, color: c.green });
  tx(s, "Depth ≤ 140°", 214, 268, 220, 34, { size: 20, bold: true });
  tx(s, "Angle gap ≤ 18°", 460, 268, 230, 34, { size: 20, bold: true });
  tx(s, "Trunk lean ≤ 22°", 720, 268, 250, 34, { size: 20, bold: true });
  tx(s, "Real results from output1", 70, 329, 500, 32, { size: 23, bold: true });
  const values = [
    ["Rep", "Minimum knee angle", "Maximum L/R gap", "Maximum trunk lean", "Result"],
    ["1", "119.4°", "3.8°", "8.7°", "Valid"],
    ["2", "116.7°", "2.9°", "9.3°", "Valid"],
    ["3", "111.9°", "2.3°", "7.7°", "Valid"],
    ["4", "112.5°", "3.0°", "9.2°", "Valid"],
    ["5", "108.4°", "3.2°", "9.4°", "Valid"],
  ];
  const table = s.tables.add({ rows: 6, columns: 5, left: 70, top: 377, width: 1140, height: 218, columnWidths: [100, 270, 250, 270, 150], values });
  styleTable(table, 6, 5);
  tx(s, "Pelvis drop / mean leg length is logged, but it does not affect pass or fail yet.", 70, 618, 1030, 28, { size: 15, color: c.muted });
  footer(s, 3);
  s.speakerNotes.textFrame.setText("The detector computes both hip-knee-ankle angles, uses the more flexed side for phase detection, and evaluates depth, symmetry, and pelvis-to-neck lean over each completed cycle. Real results come from output1/back_extension_knee_bends/joints3d_global.npy. Prototype thresholds require PT calibration.");
}

// Slide 4
{
  const s = p.slides.add();
  s.background.fill = c.white;
  heading(s, "One-leg-stand detector", "Balance rule");
  tx(s, "Joints", 70, 139, 110, 24, { size: 14, bold: true, color: c.green });
  tx(s, "lifted ankle; stance hip, knee, ankle and foot; pelvis and neck", 175, 134, 960, 34, { size: 22, bold: true });
  box(s, 70, 183, 1140, 2, c.line);
  const rules = [
    ["Foot lift", "≥ 0.18 leg lengths"],
    ["Stance drift", "≤ 0.12 leg lengths"],
    ["Pelvis sway", "≤ 0.22 leg lengths"],
    ["Trunk lean", "≤ 20°"],
  ];
  rules.forEach(([h, b], i) => {
    const x = 70 + i * 285;
    tx(s, h, x, 220, 250, 30, { size: 18, bold: true, color: c.green });
    tx(s, b, x, 257, 250, 36, { size: 23, bold: true });
  });
  box(s, 70, 315, 1140, 63, c.navy, "roundRect");
  tx(s, "All four conditions must remain valid for 10 seconds. Any invalid frame resets the timer.", 94, 333, 1090, 30, { size: 21, bold: true, color: c.white, align: "center" });
  tx(s, "Real results from output2", 70, 412, 500, 32, { size: 23, bold: true });
  const values = [
    ["Side", "Hold", "Lift ratio", "Max. stance drift", "Max. pelvis sway", "Max. trunk lean", "Result"],
    ["Left foot lifted", "10.0 s", "0.343", "0.017", "0.030", "5.0°", "Valid"],
    ["Right foot lifted", "10.0 s", "0.247", "0.007", "0.021", "8.0°", "Valid"],
  ];
  const table = s.tables.add({ rows: 3, columns: 7, left: 70, top: 463, width: 1140, height: 130, columnWidths: [210, 120, 135, 180, 175, 175, 120], values });
  styleTable(table, 3, 7);
  tx(s, "Distances use stance leg length: hip-to-knee plus knee-to-ankle.", 70, 617, 860, 28, { size: 15, color: c.muted });
  footer(s, 4);
  s.speakerNotes.textFrame.setText("The support foot and pelvis are tracked in the horizontal XZ plane. Displacements are normalized by stance leg length. Real results come from output2/heel_toe_standing_one_leg_stand/joints3d_global.npy. Prototype thresholds require PT calibration.");
}

// Slide 5
{
  const s = p.slides.add();
  s.background.fill = c.white;
  heading(s, "Motion-to-agent interface", "Function design");
  const xs = [70, 470, 870];
  const headers = ["Action detector", "Shared event schema", "Controller and voice"];
  const bodies = [
    "KneeBendDetector\nOneLegStandDetector\n\nDifferent joints and rules", 
    "exercise\nobservation\nassessment\n\nSame output structure",
    "submit_session_event\n\nevent = motion_observation\n\nNo LLM tool per exercise",
  ];
  headers.forEach((h, i) => {
    tx(s, h, xs[i], 153, 330, 32, { size: 21, bold: true, color: c.green });
    box(s, xs[i], 202, 330, 210, i === 1 ? c.mint : c.pale, "roundRect");
    tx(s, bodies[i], xs[i] + 24, 232, 282, 160, { size: 20, bold: true, color: i === 1 ? c.green : c.ink });
  });
  tx(s, "Model-facing policy", 70, 455, 350, 32, { size: 23, bold: true });
  const rows = [
    ["Ordinary valid frame", "Local detector only"],
    ["Valid repetition", "Update deterministic controller"],
    ["Correction or safety event", "Generate an immediate voice cue"],
    ["Prescribed target complete", "Advance state and introduce the next task"],
  ];
  rows.forEach(([a, b], i) => {
    const y = 503 + i * 38;
    tx(s, a, 70, y, 325, 28, { size: 17, bold: true });
    tx(s, b, 415, y, 600, 28, { size: 17, color: c.muted });
  });
  box(s, 1030, 478, 180, 145, c.navy, "roundRect");
  tx(s, "Compact event", 1050, 497, 140, 24, { size: 14, bold: true, color: "#9FD2B1" });
  tx(s, "rep_completed\ncorrect\ncount +1", 1050, 538, 140, 72, { size: 19, bold: true, color: c.white });
  footer(s, 5);
  s.speakerNotes.textFrame.setText("The motion code has action-specific detectors, but GPT does not receive a separate function for every exercise. All detectors emit a common semantic event. The deterministic controller owns counts and state transitions. GPT receives only milestones and problems. Sources: public/gvhmr-motion.js; public/motion-schema.js; public/app.js pushMotionEvent; submit_session_event tool in the local controller.");
}

await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(path.dirname(finalPath), { recursive: true });
const candidatePath = path.join(buildDir, "candidate-motion-briefing.pptx");
await (await PresentationFile.exportPptx(p)).save(candidatePath);

const { finalizePresentation } = await import(pathToFileURL(path.join(SKILL_DIR, "container_tools/artifact_tool_utils.mjs")).href);
const result = await finalizePresentation({
  explicitTotalSlideCount: 5,
  requiredNativeTableOwnerSlides: [3, 4],
  requiredNativeChartOwnerSlides: [],
  workspaceDir,
  candidatePath,
  finalPath,
  pythonExecutable,
  integrityValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: ["--expected-slide-size-emu", "12192000,6858000", "--validate-heading-fit", "--require-native-table-slide", "3", "--require-native-table-slide", "4"],
  requiredNativeTableOwnerSlides: [3, 4],
  fontPolicy: { basis: "design", families: [FONT] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(buildDir, "Otago_Motion_Interface_Briefing_v2.validation.json"),
});
console.log(JSON.stringify(result, null, 2));
