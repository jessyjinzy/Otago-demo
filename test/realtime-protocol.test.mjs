import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeSessionConfig, createRealtimeStateUpdate, resolveRealtimeProtocol } from "../realtime-protocol.mjs";

const input = {
  model: "gpt-realtime", instructions: "coach", tools: [], voice: "cedar",
  transcriptionModel: "gpt-4o-transcribe", reasoningEffort: "medium",
  truncation: { type: "retention_ratio" },
};

test("auto-selects legacy for the unversioned XTY route and modern for 2.x", () => {
  assert.equal(resolveRealtimeProtocol("gpt-realtime"), "legacy");
  assert.equal(resolveRealtimeProtocol("gpt-realtime-1.5"), "legacy");
  assert.equal(resolveRealtimeProtocol("gpt-realtime-2.1"), "modern");
});

test("legacy session schema omits modern-only fields", () => {
  const session = createRealtimeSessionConfig({ ...input, protocol: "legacy" });
  assert.deepEqual(session.modalities, ["text", "audio"]);
  assert.equal(session.input_audio_format, "pcm16");
  assert.equal(session.type, undefined);
  assert.equal(session.model, undefined);
  assert.equal(session.reasoning, undefined);
  assert.equal(session.output_modalities, undefined);
  assert.equal(session.audio, undefined);
  assert.equal(session.truncation, undefined);

  const update = createRealtimeStateUpdate({ ...input, protocol: "legacy" });
  assert.deepEqual(Object.keys(update).sort(), ["instructions", "tool_choice", "tools"]);
});

test("modern session schema retains 2.x fields", () => {
  const session = createRealtimeSessionConfig({ ...input, protocol: "modern", model: "gpt-realtime-2.1" });
  assert.equal(session.type, "realtime");
  assert.equal(session.model, "gpt-realtime-2.1");
  assert.deepEqual(session.output_modalities, ["audio"]);
  assert.equal(session.reasoning.effort, "medium");
  assert.ok(session.audio.input.turn_detection);
});
