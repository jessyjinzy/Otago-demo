import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeResponseConfig } from "../public/realtime-response.js";

test("legacy response config strips modern-only parallel tool calling", () => {
  const response = createRealtimeResponseConfig("legacy", {
    instructions: "continue", tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 700,
  });
  assert.deepEqual(response.modalities, ["text", "audio"]);
  assert.equal(response.parallel_tool_calls, undefined);
  assert.equal(response.output_modalities, undefined);
  assert.equal(response.max_output_tokens, 700);
});

test("modern response config retains parallel tool calling control", () => {
  const response = createRealtimeResponseConfig("modern", { parallel_tool_calls: false });
  assert.deepEqual(response.output_modalities, ["audio"]);
  assert.equal(response.parallel_tool_calls, false);
});
