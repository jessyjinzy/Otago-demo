import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeFormData } from "../realtime-form.mjs";

test("encodes SDP and session as named multipart text fields", async () => {
  const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";
  const session = {
    type: "realtime",
    model: "gpt-realtime-mini",
  };

  const request = new Request("http://localhost/realtime", {
    method: "POST",
    body: createRealtimeFormData(offerSdp, session),
  });
  const parsed = await request.formData();

  assert.equal(typeof parsed.get("sdp"), "string");
  assert.equal(parsed.get("sdp"), offerSdp);
  assert.equal(typeof parsed.get("session"), "string");
  assert.deepEqual(JSON.parse(parsed.get("session")), session);
});
