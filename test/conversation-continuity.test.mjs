import test from "node:test";
import assert from "node:assert/strict";
import { buildContinuityInstruction } from "../public/conversation-continuity.js";

test("continuity instruction carries only compact adjacent dialogue context", () => {
  const instruction = buildContinuityInstruction({
    lastCoach: "Great, let's move on to knee bends. We'll do five.",
    lastUser: "Okay, I'm ready.",
    state: "active_set",
    reason: "setup_ready",
  });
  assert.match(instruction, /Previous coach utterance/);
  assert.match(instruction, /five/);
  assert.match(instruction, /I'm ready/);
  assert.match(instruction, /Do not repeat/);
  assert.ok(instruction.length < 1800);
});

test("continuity context truncates unexpectedly long transcripts", () => {
  const instruction = buildContinuityInstruction({ lastCoach: "x".repeat(2000), lastUser: "y".repeat(2000) });
  assert.ok(instruction.length < 1800);
  assert.match(instruction, /…/);
});
