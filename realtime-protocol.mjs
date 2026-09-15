export function resolveRealtimeProtocol(model, configured = "auto") {
  const value = String(configured || "auto").trim().toLowerCase();
  if (!["auto", "legacy", "modern"].includes(value)) {
    throw new Error("XTY_REALTIME_PROTOCOL must be auto, legacy, or modern.");
  }
  if (value !== "auto") return value;
  return /^gpt-realtime-2(?:\.|$|-)/i.test(String(model || "")) ? "modern" : "legacy";
}

export function createRealtimeSessionConfig({
  protocol, model, instructions, tools, voice, transcriptionModel,
  reasoningEffort, truncation, maxOutputTokens = 800,
}) {
  if (protocol === "legacy") {
    return {
      modalities: ["text", "audio"],
      instructions,
      voice,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: transcriptionModel },
      turn_detection: {
        type: "server_vad", threshold: 0.5, prefix_padding_ms: 300,
        silence_duration_ms: 650, create_response: true, interrupt_response: true,
      },
      tools,
      tool_choice: "auto",
      max_response_output_tokens: maxOutputTokens,
    };
  }
  return {
    type: "realtime",
    model,
    instructions,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: reasoningEffort },
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        transcription: { model: transcriptionModel },
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "server_vad", threshold: 0.5, prefix_padding_ms: 300,
          silence_duration_ms: 650, create_response: true, interrupt_response: true,
        },
      },
      output: { format: { type: "audio/pcm", rate: 24_000 }, voice },
    },
    max_output_tokens: maxOutputTokens,
    truncation,
  };
}

export function createRealtimeStateUpdate({ protocol, model, instructions, tools, truncation }) {
  if (protocol === "legacy") return { instructions, tools, tool_choice: "auto" };
  return {
    type: "realtime", model, instructions, tools, tool_choice: "auto",
    parallel_tool_calls: false, truncation,
  };
}
