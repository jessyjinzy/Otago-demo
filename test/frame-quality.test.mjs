import test from "node:test";
import assert from "node:assert/strict";
import { assessPixelData } from "../public/frame-quality.js";

function pixels(values) {
  return new Uint8ClampedArray(values.flatMap((value) => [value, value, value, 255]));
}

test("rejects a black camera frame", () => {
  const result = assessPixelData(pixels([0, 0, 0, 0]));
  assert.equal(result.usable, false);
});

test("rejects a uniformly dim covered-lens frame", () => {
  const result = assessPixelData(pixels([45, 47, 49, 46, 48, 44]));
  assert.equal(result.usable, false);
  assert.ok(result.mean < 60);
  assert.ok(result.deviation < 12);
});

test("accepts a normally exposed frame with visible contrast", () => {
  const result = assessPixelData(pixels([35, 70, 105, 145, 180, 220]));
  assert.equal(result.usable, true);
});
