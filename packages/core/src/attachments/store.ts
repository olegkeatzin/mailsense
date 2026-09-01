import fs from "node:fs";
import path from "node:path";

export function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, "_").slice(0, 200);
  return base || "attachment";
}

export function saveAttachmentFile(
  dataDir: string,
  emailId: string,
  filename: string,
  content: Buffer
): string {
  const dir = path.join(dataDir, "attachments", emailId);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, sanitizeFilename(filename));
  fs.writeFileSync(full, content);
  return full;
}
