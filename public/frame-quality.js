export function assessPixelData(data) {
  if (!data?.length || data.length % 4 !== 0) throw new Error("RGBA pixel data is required.");
  let sum = 0; let sumSquares = 0; let dark = 0;
  const count = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    sum += luminance; sumSquares += luminance * luminance;
    if (luminance < 32) dark += 1;
  }
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
  const darkRatio = dark / count;
  const usable = mean >= 18 && darkRatio < 0.94 && !(mean < 60 && deviation < 12);
  return {
    usable, mean, deviation, darkRatio,
    summary: `brightness ${mean.toFixed(0)}/255, contrast ${deviation.toFixed(0)}, dark pixels ${Math.round(darkRatio * 100)}%`,
  };
}
