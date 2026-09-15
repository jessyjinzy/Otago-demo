import test from "node:test";
import assert from "node:assert/strict";
import { decodeVisionImage, sanitizeCaptureKind } from "../vision-storage.mjs";

test("decodes an approved JPEG data URI", () => {
  const result = decodeVisionImage("data:image/jpeg;base64,/9j/2Q==");
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.extension, ".jpg");
  assert.ok(result.bytes.length > 0);
});

test("rejects non-image and oversized payloads", () => {
  assert.throws(() => decodeVisionImage("data:text/plain;base64,SGk="), /JPEG and PNG/);
  assert.throws(() => decodeVisionImage("data:image/png;base64,QUJDRA==", 2), /exceeds/);
});

test("sanitizes capture kinds for generated filenames", () => {
  assert.equal(sanitizeCaptureKind("Exercise Setup / Left"), "exercise-setup-left");
});
