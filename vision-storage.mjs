const IMAGE_DATA_URI = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=\r\n]+)$/;

export function decodeVisionImage(dataUri, maxBytes = 5_000_000) {
  if (typeof dataUri !== "string") throw new Error("image_data must be a JPEG or PNG data URI.");
  const match = dataUri.match(IMAGE_DATA_URI);
  if (!match) throw new Error("Only base64 JPEG and PNG data URIs are accepted.");
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length) throw new Error("The image is empty.");
  if (bytes.length > maxBytes) throw new Error(`The decoded image exceeds ${maxBytes} bytes.`);
  const mimeType = match[1] === "png" ? "image/png" : "image/jpeg";
  const extension = match[1] === "png" ? ".png" : ".jpg";
  const validJpeg = mimeType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const validPng = mimeType === "image/png" && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!validJpeg && !validPng) throw new Error("The decoded bytes do not match the declared JPEG or PNG format.");
  return { bytes, mimeType, extension };
}

export function sanitizeCaptureKind(value) {
  const normalized = String(value || "vision_capture").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 60) || "vision_capture";
}
