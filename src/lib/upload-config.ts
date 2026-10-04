import path from "path";

/**
 * Single source of truth for upload limits and accepted formats.
 * Imported by BOTH the client UI and the server route so the frontend limit
 * can never contradict the backend limit.
 *
 * Ceiling rationale (measured on this deployment):
 *  - the API streams to disk, so RAM is no longer the constraint;
 *  - the sandbox has ~3.9 GB RAM and the reverse proxy tolerated 400 MB
 *    comfortably, while 800 MB previously OOM-crashed the old buffered route.
 *  - 1 GB is therefore a safe, honest production ceiling for this server.
 * Raise MAX_VIDEO_MB only together with storage/proxy capacity.
 */
export const MAX_VIDEO_MB = 1024; // 1 GB
export const MAX_IMAGE_MB = 12;

export const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;
export const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;

/** Upload chunk size — small enough to retry cheaply on mobile networks. */
export const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Accepted video containers. Browsers report MOV inconsistently
 * (video/quicktime, video/x-quicktime, sometimes empty), so extension is a
 * valid fallback signal — we never reject a real video just because the
 * browser sent an odd MIME string.
 */
export const VIDEO_MIME_PREFIXES = ["video/"];
export const VIDEO_MIME_EXTRA = [
  "application/octet-stream", // some Android pickers report this for .mp4
  "application/mp4",
  "application/x-mpegurl",
];
export const VIDEO_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".mov",
  ".qt",
  ".webm",
  ".mkv",
  ".avi",
  ".3gp",
  ".3g2",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".ts",
];

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"];

/** File input `accept` values. */
export const VIDEO_ACCEPT = `video/*,${VIDEO_EXTENSIONS.join(",")}`;
export const IMAGE_ACCEPT = "image/*";

export function fileExtension(filename: string): string {
  return path.extname(String(filename || "")).toLowerCase();
}

export function isAllowedVideo(filename: string, mimeType: string): boolean {
  const mime = String(mimeType || "").toLowerCase();
  const ext = fileExtension(filename);
  if (VIDEO_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  if (VIDEO_EXTENSIONS.includes(ext)) return true;
  // Only trust the generic MIME when the extension also looks like a video.
  if (VIDEO_MIME_EXTRA.includes(mime) && VIDEO_EXTENSIONS.includes(ext)) return true;
  return false;
}

export function isAllowedImage(filename: string, mimeType: string): boolean {
  const mime = String(mimeType || "").toLowerCase();
  const ext = fileExtension(filename);
  if (mime.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.includes(ext);
}

export function detectKind(filename: string, mimeType: string): "video" | "image" {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  const ext = fileExtension(filename);
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  return "video";
}

/** Safe on-disk extension; falls back to a sane default per kind. */
export function extensionFor(
  filename: string,
  mimeType: string,
  kind: "video" | "image"
): string {
  const ext = fileExtension(filename);
  const allowed = kind === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  if (allowed.includes(ext)) return ext;

  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("webm")) return kind === "video" ? ".webm" : ".webp";
  if (mime.includes("quicktime")) return ".mov";
  if (mime.includes("png")) return ".png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return kind === "video" ? ".mp4" : ".jpg";
}

export function uploadsDir(): string {
  return path.resolve(process.cwd(), ".data", "uploads");
}

export function tempDir(): string {
  return path.resolve(process.cwd(), ".data", "tmp");
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
