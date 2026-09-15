export class XtyRealtimeAudioTransport {
  constructor({ microphoneStream, voice, onEvent, onError, onClose }) {
    this.microphoneStream = microphoneStream;
    this.onEvent = onEvent;
    this.onError = onError;
    this.onClose = onClose;
    this.socket = undefined;
    this.audioContext = undefined;
    this.source = undefined;
    this.processor = undefined;
    this.silentGain = undefined;
    this.playbackTime = 0;
    this.playingSources = new Set();
    this.localSessionId = undefined;
    this.model = undefined;
    this.voice = voice || "marin";
    this.closedByClient = false;
    this.maxMessageSize = 1_000_000;
  }

  get readyState() {
    return this.socket?.readyState === WebSocket.OPEN ? "open" : "closed";
  }

  async connect(timeoutMs = 20_000) {
    this.audioContext = new AudioContext({ sampleRate: 24_000, latencyHint: "interactive" });
    await this.audioContext.resume();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${scheme}//${location.host}/api/realtime/ws`);
    url.searchParams.set("voice", this.voice);
    this.socket = new WebSocket(url);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to the local XTY Realtime relay.")), timeoutMs);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      this.socket.addEventListener("message", async (message) => {
        let event;
        try {
          const text = typeof message.data === "string" ? message.data : await message.data.text();
          event = JSON.parse(text);
        } catch {
          return;
        }

        if (event.type === "otago.session.created") {
          this.localSessionId = event.local_session_id;
          this.model = event.model;
          this.voice = event.voice || this.voice;
          return;
        }
        if (event.type === "otago.relay.ready") {
          this.localSessionId ||= event.local_session_id;
          this.model ||= event.model;
          this.voice = event.voice || this.voice;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.startMicrophone();
            resolve();
          }
          return;
        }
        if (event.type === "otago.relay.error") {
          const error = new Error(event.message || event.error?.message || "XTY Realtime relay failed.");
          error.code = event.code || event.error?.code;
          if (!settled) fail(error); else this.onError?.(error);
          return;
        }

        if (["response.output_audio.delta", "response.audio.delta"].includes(event.type) && event.delta) {
          this.playAudioDelta(event.delta);
        }
        if (event.type === "input_audio_buffer.speech_started") this.stopPlayback();
        this.onEvent?.({ data: JSON.stringify(event) });
      });

      this.socket.addEventListener("error", () => fail(new Error("Could not connect to the local XTY Realtime relay.")));
      this.socket.addEventListener("close", () => {
        if (!settled) fail(new Error("The local XTY Realtime relay closed during setup."));
        else if (!this.closedByClient) this.onClose?.();
      });
    });
    return this;
  }

  send(serialized) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("XTY Realtime relay is not open.");
    if (new TextEncoder().encode(serialized).byteLength > this.maxMessageSize) throw new Error("Message exceeds the local XTY relay limit.");
    this.socket.send(serialized);
  }

  close() {
    this.closedByClient = true;
    this.stopPlayback();
    try { this.processor?.disconnect(); } catch { /* already disconnected */ }
    try { this.source?.disconnect(); } catch { /* already disconnected */ }
    try { this.silentGain?.disconnect(); } catch { /* already disconnected */ }
    try { this.socket?.close(1000, "Session ended"); } catch { /* already closed */ }
    void this.audioContext?.close();
  }

  startMicrophone() {
    const context = this.audioContext;
    this.source = context.createMediaStreamSource(this.microphoneStream);
    this.processor = context.createScriptProcessor(2048, 1, 1);
    this.silentGain = context.createGain();
    this.silentGain.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleFloat32(input, context.sampleRate, 24_000);
      this.socket.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: encodePcm16(resampled),
      }));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(context.destination);
  }

  playAudioDelta(base64Audio) {
    const context = this.audioContext;
    if (!context || context.state === "closed") return;
    const pcm = decodePcm16(base64Audio);
    if (!pcm.length) return;
    const buffer = context.createBuffer(1, pcm.length, 24_000);
    buffer.copyToChannel(pcm, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.015, this.playbackTime);
    source.start(startAt);
    this.playbackTime = startAt + buffer.duration;
    this.playingSources.add(source);
    source.onended = () => this.playingSources.delete(source);
  }

  stopPlayback() {
    for (const source of this.playingSources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.playingSources.clear();
    this.playbackTime = this.audioContext?.currentTime || 0;
  }
}

function resampleFloat32(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function encodePcm16(floatSamples) {
  const bytes = new Uint8Array(floatSamples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < floatSamples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatSamples[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytesToBase64(bytes);
}

function decodePcm16(base64Audio) {
  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const output = new Float32Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < output.length; index += 1) output[index] = view.getInt16(index * 2, true) / 0x8000;
  return output;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
