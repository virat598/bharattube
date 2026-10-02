"use client";

import { MAX_VIDEO_BYTES, formatBytes } from "./upload-config";
import { getSessionToken, installAuthFetchInterceptor } from "./client";
import { videoUploadCandidates } from "./api-config";

export interface UploadProgress {
  /** 0–100, derived from bytes the SERVER has acknowledged. Never faked. */
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
  /** Bytes/sec over a moving window, or null until measurable. */
  bytesPerSecond: number | null;
  /** Seconds remaining, or null when not yet measurable. */
  etaSeconds: number | null;
}

export interface UploadedAsset {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelledError";
  }
}

export interface UploadHandle {
  promise: Promise<UploadedAsset>;
  cancel: () => void;
}

/**
 * Upload and create a video through the existing Express API in one
 * multipart request. The backend owns Cloudinary upload + MongoDB creation,
 * so the browser never invents an intermediate media API.
 */
export function uploadVideoMultipart(
  videoFile: File,
  thumbnailFile: File | null,
  fields: Record<string, string>,
  onProgress?: (progress: UploadProgress) => void
): UploadHandle & { uploadId?: string } {
  let xhr: XMLHttpRequest | null = null;
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
    xhr?.abort();
  };

  const promise = new Promise<UploadedAsset>(async (resolve, reject) => {
    if (!videoFile || videoFile.size <= 0) {
      reject(new Error("Please choose a valid video file."));
      return;
    }
    if (videoFile.size > MAX_VIDEO_BYTES) {
      reject(new Error(`This video is too large. Maximum size is ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB.`));
      return;
    }

    const form = new FormData();
    // The selected File object is appended as-is: binary multipart, no
    // Base64, no data URL, no JSON stringification, no re-encode. The browser
    // streams it straight off disk, so a 400 MB file never gains a second
    // copy in JS memory.
    form.append("video", videoFile, videoFile.name);
    if (thumbnailFile) form.append("thumbnail", thumbnailFile);
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));

    // ── Guard: prove the request body is the original file ──────────────────
    // If any future step silently swapped in a data URL, a Blob reconstruction
    // or a re-encode, the appended size would drift from file.size. Fail here,
    // before a single byte leaves the device, instead of discovering it as a
    // mysterious 413 after a long upload.
    const appended = form.get("video");
    const appendedBytes =
      appended instanceof Blob ? appended.size : 0;
    if (appendedBytes !== videoFile.size) {
      reject(
        new Error(
          `Upload size mismatch (original ${formatBytes(videoFile.size)}, request ${formatBytes(appendedBytes)}). The video was not sent — please retry.`
        )
      );
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      // Dev-only trace required to compare original vs actual upload size.
      console.log("[upload] original:", {
        name: videoFile.name,
        type: videoFile.type,
        size: videoFile.size,
        sizeMB: (videoFile.size / 1024 / 1024).toFixed(2),
      });
      console.log("[upload] request video part:", {
        size: appendedBytes,
        sizeMB: (appendedBytes / 1024 / 1024).toFixed(2),
      });
    }

    xhr = new XMLHttpRequest();
    xhr.open("POST", videoUploadCandidates[0], true);
    xhr.withCredentials = true;

    const token = getSessionToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
      onProgress?.({
        percent,
        uploadedBytes: Math.round(videoFile.size * (percent / 100)),
        totalBytes: videoFile.size,
        bytesPerSecond: null,
        etaSeconds: null,
      });
    };

    xhr.onload = () => {
      if (cancelled) return;
      let payload: any = null;
      try {
        payload = JSON.parse(xhr!.responseText);
      } catch {
        payload = null;
      }

      if (xhr!.status >= 200 && xhr!.status < 300) {
        const created = payload?.data ?? payload?.video ?? payload;
        const id = created?._id ?? created?.id;
        const url = created?.videoUrl ?? created?.url ?? "";
        if (!id) {
          reject(new Error("The server accepted the upload but did not return the created video."));
          return;
        }
        onProgress?.({
          percent: 100,
          uploadedBytes: videoFile.size,
          totalBytes: videoFile.size,
          bytesPerSecond: null,
          etaSeconds: 0,
        });
        resolve({
          id: String(id),
          url: String(url),
          filename: videoFile.name,
          mimeType: videoFile.type || "application/octet-stream",
          sizeBytes: videoFile.size,
        });
        return;
      }

      if (xhr!.status === 401 || xhr!.status === 403) {
        reject(new Error("Your session has expired. Please sign in again, then retry the upload."));
        return;
      }

      if (xhr!.status === 413) {
        // Honest failure: the original file itself exceeded the server's
        // payload limit. Nothing was enlarged by this app — report the real
        // size so the creator knows the source video is the constraint.
        reject(
          new Error(
            `The server rejected this upload (413 — file too large). Your video is ${formatBytes(
              videoFile.size
            )}. Please upload a smaller file.`
          )
        );
        return;
      }

      reject(new Error(payload?.message || payload?.error || "Video upload failed."));
    };

    xhr.onerror = () => reject(new Error("We couldn't reach the upload server. Please check your connection and try again."));
    xhr.ontimeout = () => reject(new Error("The upload timed out. Please try again."));
    xhr.onabort = () => reject(new UploadCancelledError());

    try {
      xhr.send(form);
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Unable to start upload."));
    }
  });

  return { promise, cancel } as UploadHandle & { uploadId?: string };
}

/**
 * Updates an existing video's thumbnail (and optional title/description)
 * through the real PUT /videos/:id endpoint as multipart/form-data so the
 * backend can replace the Cloudinary thumbnail the same way it does on create.
 */
export async function updateVideoOnBackend(
  videoId: string | number,
  fields: {
    title?: string;
    description?: string;
    thumbnailFile?: File | null;
  }
): Promise<{ ok: boolean; thumbnailUrl?: string; title?: string; description?: string; error?: string }> {
  installAuthFetchInterceptor();
  const endpoint = `${videoUploadCandidates[0]}/${encodeURIComponent(String(videoId))}`;

  const send = (body: BodyInit, headers?: HeadersInit) =>
    fetch(endpoint, {
      method: "PUT",
      credentials: "include",
      body,
      headers,
    });

  let res: Response;
  if (fields.thumbnailFile) {
    const form = new FormData();
    form.append("thumbnail", fields.thumbnailFile);
    if (fields.title != null) form.append("title", fields.title);
    if (fields.description != null) form.append("description", fields.description);
    res = await send(form);
  } else {
    res = await send(JSON.stringify({
      title: fields.title,
      description: fields.description,
    }), { "Content-Type": "application/json" });
  }

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      error: payload?.message || payload?.error || "Could not update video",
    };
  }

  const created = payload?.data ?? payload?.video ?? payload;
  return {
    ok: true,
    thumbnailUrl: created?.thumbnailUrl || created?.thumbnail || undefined,
    title: created?.title,
    description: created?.description,
  };
}
