export function createRealtimeResponseConfig(protocol, overrides = {}) {
  if (protocol === "legacy") {
    const { parallel_tool_calls: _parallelToolCalls, output_modalities: _outputModalities, ...legacyOverrides } = overrides;
    return { modalities: ["text", "audio"], ...legacyOverrides };
  }
  return { output_modalities: ["audio"], ...overrides };
}
