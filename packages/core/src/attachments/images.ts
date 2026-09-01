function sniffMime(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return "image/png";
}

export function imageToDataUrl(content: Buffer, fallbackMime = "image/png"): string {
  const mime = sniffMime(content) || fallbackMime;
  return "data:" + mime + ";base64," + content.toString("base64");
}

export const SUPPORTED_IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
