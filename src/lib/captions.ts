/**
 * Real caption/subtitle resolution for BharatTube.
 *
 * Verified against the deployed backend (https://bharattube-ylmq.onrender.com/api/v1):
 *   - there is NO /captions or /subtitles route
 *   - the video document has no captions field
 *   - videos are hosted on Cloudinary and expose `videoPublicId`
 *   - Cloudinary answers with `Access-Control-Allow-Origin: *`
 *
 * So captions can only come from REAL sources:
 *   1. explicit caption/subtitle fields on the video document, if the backend
 *      ever adds them (`captions`, `subtitles`, `captionUrl`, `tracks`, …)
 *   2. a transcript file published next to the media in Cloudinary
 *      (`<videoPublicId>.vtt` / `.srt` in /raw/upload/), which is probed live.
 *
 * Nothing is invented: if no real track answers, `available` is false and the
 * player honestly reports "No captions available".
 */

export interface CaptionTrack {
  /** ISO language code (best effort, defaults to the video language). */
  lang: string;
  label: string;
  /** Absolute URL of the REAL caption file. */
  src: string;
  format: "vtt" | "srt";
}

const TIMEOUT_MS = 8000;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function formatOf(url: string): "vtt" | "srt" | null {
  if (/\.vtt(\?|$)/i.test(url)) return "vtt";
  if (/\.srt(\?|$)/i.test(url)) return "srt";
  return null;
}

/**
 * Collects caption tracks that the backend explicitly stores on the video
 * document. Only real URLs/files count.
 */
export function extractCaptionSources(raw: unknown): CaptionTrack[] {
  if (!raw || typeof raw !== "object") return [];
  const video = raw as Record<string, any>;
  const fallbackLang = asString(video.language) || "en";
  const found: CaptionTrack[] = [];
  const seen = new Set<string>();

  const push = (url: unknown, lang?: unknown, label?: unknown) => {
    const src = asString(url);
    if (!src || !isHttpUrl(src) || seen.has(src)) return;
    const format = formatOf(src);
    if (!format) return;
    seen.add(src);
    found.push({
      src,
      format,
      lang: asString(lang) || fallbackLang,
      label: asString(label) || (format === "vtt" ? "Captions" : "Subtitles"),
    });
  };

  // Single-string fields used by common backends.
  push(
    video.captions ?? video.captionUrl ?? video.caption,
    video.captionLanguage ?? video.language,
    "Captions"
  );
  push(
    video.subtitles ?? video.subtitleUrl ?? video.subtitle,
    video.subtitleLanguage ?? video.language,
    "Subtitles"
  );

  // Array/object shapes: captions: [{ url, lang, label }] | { en: {url} }
  for (const key of ["captions", "subtitles", "tracks", "captionTracks"] as const) {
    const value = video[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          push(entry);
        } else if (entry && typeof entry === "object") {
          push(
            entry.url ?? entry.src ?? entry.file ?? entry.path,
            entry.lang ?? entry.language ?? entry.srclang,
            entry.label ?? entry.name
          );
        }
      }
    } else if (value && typeof value === "object") {
      for (const [lang, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === "string") push(entry, lang);
        else if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          push(e.url ?? e.src ?? e.file, lang, e.label);
        }
      }
    }
  }

  return found;
}

/**
 * Builds the Cloudinary transcript URLs that would exist beside this video if
 * the owner published one. These are probed before being offered to the player,
 * so a missing file never becomes a fake caption.
 */
export function cloudinaryCaptionCandidates(raw: unknown): CaptionTrack[] {
  if (!raw || typeof raw !== "object") return [];
  const video = raw as Record<string, any>;

  let publicId = asString(video.videoPublicId ?? video.video_public_id);
  const videoUrl = asString(video.videoUrl ?? video.url);

  if (!publicId && /res\.cloudinary\.com\//i.test(videoUrl)) {
    const match = videoUrl.match(/\/(?:video|raw|image)\/upload\/(?:v\d+\/)?(.+?)\.[a-z0-9]+$/i);
    if (match?.[1]) publicId = match[1];
  }
  if (!publicId) return [];

  const origin = videoUrl.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+)/i)?.[1] ?? "";
  if (!origin) return [];

  const lang = asString(video.language) || "en";
  return [
    {
      lang,
      label: "Captions",
      src: `${origin}/raw/upload/${publicId}.vtt`,
      format: "vtt" as const,
    },
    {
      lang,
      label: "Subtitles",
      src: `${origin}/raw/upload/${publicId}.srt`,
      format: "srt" as const,
    },
  ];
}

/** True when the URL really serves a caption file today. */
export async function probeCaptionTrack(track: CaptionTrack): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(track.src, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.ok) return true;
    // Some CDNs reject HEAD; confirm with a ranged GET before giving up.
    const get = await fetch(track.src, {
      headers: { Range: "bytes=0-255" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!get.ok) return false;
    const head = (await get.text()).slice(0, 512);
    // A real caption file never starts with HTML/XML error markup.
    return !/^\s*<(?:!doctype|html|\?xml)/i.test(head);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves every REAL caption track for a video, in priority order. */
export async function resolveCaptionTracks(raw: unknown): Promise<CaptionTrack[]> {
  const explicit = extractCaptionSources(raw);
  const derived = cloudinaryCaptionCandidates(raw).filter(
    (candidate) => !explicit.some((track) => track.src === candidate.src)
  );

  const ordered = [...explicit, ...derived];
  if (ordered.length === 0) return [];

  const checks = await Promise.all(ordered.map(probeCaptionTrack));
  return ordered.filter((_, index) => checks[index]);
}

/* ── SubRip → WebVTT so the browser's native <track> can always render ── */

function pad(value: number, size: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(size, "0");
}

function normalizeTimestamp(raw: string): string | null {
  const cleaned = raw.trim().replace(/,/g, ".");
  const match = cleaned.match(
    /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/
  );
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const totalMs = Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  return `${pad(totalSeconds / 3600, 2)}:${pad((totalSeconds / 60) % 60, 2)}:${pad(
    totalSeconds % 60,
    2
  )}.${pad(ms, 3)}`;
}

/** Converts SRT text to VTT; VTT input is passed through (validated). */
export function toVtt(input: string): string | null {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return null;

  if (/^\s*WEBVTT/i.test(text)) return text;

  const blocks = text.split(/\n{2,}/);
  const cues: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;

    const [rawStart, rawEnd] = lines[timingIndex].split("-->");
    const start = normalizeTimestamp(rawStart ?? "");
    const end = normalizeTimestamp((rawEnd ?? "").split(/\s+/).filter(Boolean)[0] ?? "");
    if (!start || !end) continue;

    const body = lines
      .slice(timingIndex + 1)
      .join("\n")
      // Strip SubRip inline tags the VTT renderer does not need.
      .replace(/<\/?[^>]+>/g, "")
      .trim();
    if (!body) continue;

    cues.push(`${start} --> ${end}\n${body}`);
  }

  if (cues.length === 0) return null;
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** Downloads a caption file and returns it as valid WebVTT text. */
export async function fetchCaptionAsVtt(track: CaptionTrack): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(track.src, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return null;
    return toVtt(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
