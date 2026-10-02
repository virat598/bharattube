"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  X,
  Upload,
  Image as ImageIcon,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Globe,
  Link2,
  Lock,
  RotateCw,
  Ban,
  ArrowLeft,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import { VIDEO_CATEGORIES } from "@/lib/format";
import {
  VIDEO_ACCEPT,
  IMAGE_ACCEPT,
  MAX_VIDEO_MB,
  MAX_VIDEO_BYTES,
  MAX_IMAGE_BYTES,
  isAllowedVideo,
  isAllowedImage,
  formatBytes,
} from "@/lib/upload-config";
import {
  uploadVideoMultipart,
  UploadCancelledError,
  type UploadProgress,
  type UploadHandle,
} from "@/lib/uploader";
import { CreateSheet, type CreateMode } from "./CreateSheet";
import { CameraRecorder } from "./CameraRecorder";
import { apiUrl } from "@/lib/api-config";
import { captureVideoFrame } from "@/lib/thumbnail";

type Stage = "choose" | "camera" | "details" | "success";
type UploadState =
  | "idle"
  | "uploading"
  | "processing"
  | "ready"
  | "publishing"
  | "error"
  | "cancelled";

function secondsToEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "";
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec % 60);
  return `${m}m ${s}s left`;
}

export function UploadStudio({ onClose }: { onClose: () => void }) {
  const { triggerFeedRefresh, showToast, refreshUser } = useApp();

  const [stage, setStage] = useState<Stage>("choose");
  const [isShort, setIsShort] = useState(false);

  // Selected source file + local preview
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [duration, setDuration] = useState(0);

  // Upload lifecycle
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  // Thumbnail
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [frameTime, setFrameTime] = useState(0);
  const frameVideoRef = useRef<HTMLVideoElement>(null);

  // Metadata
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Entertainment");
  const [tags, setTags] = useState("");
  const [visibility, setVisibility] = useState<"public" | "unlisted" | "private">(
    "public"
  );
  const [publishMode, setPublishMode] = useState<"now" | "schedule">("now");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [playlistId, setPlaylistId] = useState("");
  const [playlists, setPlaylists] = useState<Array<{ id: string | number; title: string }>>([]);

  const [publishedId, setPublishedId] = useState<string | null>(null);

  const videoInputRef = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<(UploadHandle & { uploadId?: string }) | null>(null);
  const publishingRef = useRef(false); // hard guard against double publish
  const objectUrlRef = useRef("");
  const thumbnailObjectUrlRef = useRef("");

  useEffect(() => {
    fetch(apiUrl("/playlists"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { playlists: [] }))
      .then((d) => setPlaylists(d.playlists || []))
      .catch(() => {});
  }, []);

  // Always release blob URLs — never leak video memory on mobile.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      if (thumbnailObjectUrlRef.current) URL.revokeObjectURL(thumbnailObjectUrlRef.current);
    };
  }, []);

  const setPreview = (url: string) => {
    if (objectUrlRef.current && objectUrlRef.current !== url) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
    objectUrlRef.current = url;
    setPreviewUrl(url);
  };

  /** Reads duration and grabs a poster frame — metadata only, not the whole file. */
  const probeVideo = (f: File, url: string): Promise<{ duration: number; thumb: File | null }> =>
    new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      v.src = url;

      let settled = false;
      const finish = (duration: number, thumb: File | null) => {
        if (settled) return;
        settled = true;
        resolve({ duration, thumb });
      };

      v.onloadedmetadata = () => {
        const d =
          v.duration && Number.isFinite(v.duration) ? Math.round(v.duration) : 0;
        // Seek a little in to avoid a black first frame.
        try {
          v.currentTime = Math.min(1, Math.max(0.1, d * 0.1));
        } catch {
          finish(d, null);
        }
      };

      v.onseeked = () => {
        const d =
          v.duration && Number.isFinite(v.duration) ? Math.round(v.duration) : 0;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = v.videoWidth || 1280;
          canvas.height = v.videoHeight || 720;
          const ctx = canvas.getContext("2d");
          if (!ctx) return finish(d, null);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (blob) =>
              finish(
                d,
                blob ? new File([blob], "poster.jpg", { type: "image/jpeg" }) : null
              ),
            "image/jpeg",
            0.85
          );
        } catch {
          finish(d, null);
        }
      };

      v.onerror = () => finish(0, null);
      setTimeout(() => finish(0, null), 8000);
    });

  // The existing backend creates the MongoDB video record and uploads the
  // media to Cloudinary in one multipart request. We therefore wait until the
  // creator has entered metadata instead of inventing a separate /upload API.

  const acceptVideoFile = async (f: File, opts: { short: boolean; presetUrl?: string }) => {
    const looksLikeImage =
      isAllowedImage(f.name, f.type) && !isAllowedVideo(f.name, f.type);
    if (looksLikeImage) {
      // A photo was picked (some Android pickers ignore the `accept` filter).
      showToast(
        "That's a photo, not a video. Please choose an MP4, WebM, MOV, M4V or other supported video file.",
        "error"
      );
      return;
    }
    const knownVideoFormat = isAllowedVideo(f.name, f.type);
    if (f.size > MAX_VIDEO_BYTES) {
      showToast(
        `This video is ${formatBytes(f.size)}. The maximum size is ${MAX_VIDEO_MB} MB.`,
        "error"
      );
      return;
    }
    if (f.size === 0) {
      showToast("That file appears to be empty. Please choose another video.", "error");
      return;
    }

    const url = opts.presetUrl || URL.createObjectURL(f);

    // Files whose container is not recognised by name/MIME (common on Android:
    // empty type, no extension) are validated by REAL decoding before we upload
    // anything — this accepts every genuinely playable video regardless of
    // naming, and never uploads a non-video.
    let preProbedDuration = 0;
    if (!knownVideoFormat) {
      const probed = await probeVideo(f, url);
      if (!(probed.duration > 0)) {
        if (!opts.presetUrl) URL.revokeObjectURL(url);
        showToast(
          "That file couldn't be opened as a video. Please choose an MP4, WebM, MOV, M4V or other supported video file.",
          "error"
        );
        return;
      }
      preProbedDuration = probed.duration;
    }

    if (process.env.NODE_ENV !== "production") {
      // Dev-only: makes it obvious whether the original file or some processed
      // copy is being uploaded, without altering the UI.
      console.log("[upload] selected video:", {
        name: f.name,
        type: f.type,
        size: f.size,
        sizeMB: (f.size / 1024 / 1024).toFixed(2),
      });
    }

    setPreview(url);
    setFile(f);
    setIsShort(opts.short);
    setStage("details");
    if (preProbedDuration) setDuration(preProbedDuration);

    if (!title) {
      const base = f.name.replace(/\.[^/.]+$/, "").replace(/[-_]+/g, " ").trim();
      setTitle(base ? base.charAt(0).toUpperCase() + base.slice(1) : "");
    }

    // Probe metadata + create a local thumbnail. Both files are sent together
    // to the real POST /videos endpoint when the creator publishes.
    const { duration: d, thumb } = await probeVideo(f, url);
    if (d) setDuration(d);
    if (thumb && !thumbnailFile) {
      setThumbnailFile(thumb);
      if (thumbnailObjectUrlRef.current) URL.revokeObjectURL(thumbnailObjectUrlRef.current);
      const thumbUrl = URL.createObjectURL(thumb);
      thumbnailObjectUrlRef.current = thumbUrl;
      setThumbnailUrl(thumbUrl);
    }

    // Metadata is now ready; the actual upload starts when Publish is pressed.
    setUploadState("ready");
  };

  const onPickVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) acceptVideoFile(f, { short: isShort });
  };

  const onPickThumbnail = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!isAllowedImage(f.name, f.type)) {
      showToast("Unsupported image format. Please use a JPG, PNG or WebP image.", "error");
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      showToast(`Thumbnail must be smaller than ${formatBytes(MAX_IMAGE_BYTES)}.`, "error");
      return;
    }
    setThumbBusy(true);
    try {
      setThumbnailFile(f);
      if (thumbnailObjectUrlRef.current) URL.revokeObjectURL(thumbnailObjectUrlRef.current);
      const thumbUrl = URL.createObjectURL(f);
      thumbnailObjectUrlRef.current = thumbUrl;
      setThumbnailUrl(thumbUrl);
      showToast("Thumbnail selected", "success");
    } finally {
      setThumbBusy(false);
    }
  };

  const handleCreateSelect = (mode: CreateMode) => {
    if (mode === "upload") {
      setIsShort(false);
      videoInputRef.current?.click();
    } else if (mode === "record") {
      setIsShort(false);
      setStage("camera");
    } else {
      setIsShort(true);
      setStage("camera");
    }
  };

  const cancelUpload = () => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setUploadState("cancelled");
    setErrorMessage("Upload cancelled.");
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (publishingRef.current) return;
    if (!file) {
      setErrorMessage("Please choose a video first.");
      return;
    }
    if (!title.trim()) {
      setErrorMessage("Please enter a title for your video.");
      return;
    }
    if (!thumbnailFile) {
      setErrorMessage(
        isShort
          ? "Please choose a thumbnail or capture a frame from your Short."
          : "Please choose a thumbnail for your video."
      );
      return;
    }
    let scheduledAtIso = "";
    if (publishMode === "schedule") {
      if (!scheduleLocal) {
        setErrorMessage("Choose a future date and time for your scheduled video.");
        return;
      }
      const scheduled = new Date(scheduleLocal);
      if (Number.isNaN(scheduled.getTime()) || scheduled.getTime() < Date.now() + 60_000) {
        setErrorMessage("Schedule time must be at least one minute in the future.");
        return;
      }
      scheduledAtIso = scheduled.toISOString();
    }

    publishingRef.current = true;
    setUploadState("uploading");
    setProgress(null);
    setErrorMessage("");

    try {
      const handle = uploadVideoMultipart(
        file,
        thumbnailFile,
        {
          title: title.trim(),
          description: description.trim(),
          category,
          language: "Hindi",
          tags,
          // Scheduled videos remain private on the existing backend until the
          // server worker publishes them at the requested UTC instant.
          visibility: publishMode === "schedule" ? "private" : visibility,
          isShort: String(isShort),
          status: publishMode === "schedule" ? "scheduled" : "published",
          isPublished: String(publishMode !== "schedule"),
          scheduledAt: scheduledAtIso,
        },
        setProgress
      );
      handleRef.current = handle;
      const created = await handle.promise;

      if (publishMode === "schedule") {
        const scheduleRes = await fetch("/api/schedules", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: created.id,
            title: title.trim(),
            videoType: isShort ? "short" : "video",
            targetVisibility: visibility === "unlisted" ? "unlisted" : "public",
            scheduledAt: scheduledAtIso,
          }),
        });
        const schedulePayload = await scheduleRes.json().catch(() => ({}));
        if (!scheduleRes.ok) {
          throw new Error(
            schedulePayload?.error ||
              "Video uploaded privately, but scheduling could not be saved."
          );
        }
      }

      if (playlistId) {
        const playlistRes = await fetch(apiUrl(`/playlists/${encodeURIComponent(playlistId)}/videos/${created.id}`), {
          method: "POST",
          credentials: "include",
        });
        if (!playlistRes.ok) {
          const playlistError = await playlistRes.json().catch(() => ({}));
          showToast(
            playlistError?.message || "Video uploaded, but it could not be added to the selected playlist.",
            "error"
          );
        }
      }

      setPublishedId(created.id);
      setUploadState("ready");
      setStage("success");
      triggerFeedRefresh();
      await refreshUser();
      showToast("Video published", "success");
    } catch (err) {
      if (err instanceof UploadCancelledError) {
        setUploadState("cancelled");
        setErrorMessage("Upload cancelled.");
      } else {
        setUploadState("error");
        setErrorMessage(
          (err as Error).message ||
            "Upload failed. Please check your internet connection and try again."
        );
      }
    } finally {
      handleRef.current = null;
      publishingRef.current = false;
    }
  };

  const retryUpload = () => {
    setProgress(null);
    setUploadState("ready");
    setErrorMessage("");
  };

  const closeEverything = () => {
    handleRef.current?.cancel();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    if (thumbnailObjectUrlRef.current) URL.revokeObjectURL(thumbnailObjectUrlRef.current);
    onClose();
  };

  /* ----------------------------- render ----------------------------- */

  // Hidden inputs are always mounted so the native picker can be opened
  // from any stage. `capture` is deliberately NOT set here: that forces the
  // camera and hides the gallery on Android.
  const hiddenInputs = (
    <>
      <input
        ref={videoInputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        onChange={onPickVideo}
        className="hidden"
      />
      <input
        ref={thumbInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        onChange={onPickThumbnail}
        className="hidden"
      />
    </>
  );

  if (stage === "choose") {
    return (
      <>
        {hiddenInputs}
        <CreateSheet onClose={closeEverything} onSelect={handleCreateSelect} />
      </>
    );
  }

  if (stage === "camera") {
    return (
      <>
        {hiddenInputs}
        <CameraRecorder
          vertical={isShort}
          onCancel={() => setStage("choose")}
          onPickGallery={() => videoInputRef.current?.click()}
          onUse={(recorded, url, dur) => {
            setDuration(dur);
            acceptVideoFile(recorded, { short: isShort, presetUrl: url });
          }}
        />
      </>
    );
  }

  const pct = progress?.percent ?? 0;
  const busy = uploadState === "uploading" || uploadState === "processing";

  return (
    <>
      {hiddenInputs}
      <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm sm:p-4">
        <div className="w-full sm:max-w-3xl h-[94dvh] sm:h-auto sm:max-h-[90vh] rounded-t-2xl sm:rounded-2xl bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {stage === "details" && (
                <button
                  type="button"
                  onClick={() => {
                    handleRef.current?.cancel();
                    setStage("choose");
                  }}
                  aria-label="Back"
                  className="tap-target sm:hidden inline-flex items-center justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              )}
              <h2 className="text-base font-bold truncate">
                {stage === "success"
                  ? "Published"
                  : isShort
                  ? "New Short"
                  : "New video"}
              </h2>
            </div>
            <button
              type="button"
              onClick={closeEverything}
              aria-label="Close"
              className="tap-target inline-flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {stage === "success" ? (
            <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center pb-safe">
              <CheckCircle2 className="w-14 h-14 text-emerald-500 mb-4" />
              <h3 className="text-lg font-bold">Your video is live</h3>
              <p className="text-sm text-zinc-500 mt-1.5 max-w-sm">
                &ldquo;{title}&rdquo; was saved to your channel with{" "}
                <span className="font-semibold uppercase">{visibility}</span> visibility.
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                <a
                  href={isShort ? `/shorts?id=${publishedId}` : `/watch/${publishedId}`}
                  onClick={closeEverything}
                  className="px-5 py-2.5 rounded-full bg-red-600 text-white text-sm font-semibold"
                >
                  Watch now
                </a>
                <a
                  href="/my-videos"
                  onClick={closeEverything}
                  className="px-5 py-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800 text-sm font-semibold"
                >
                  Your videos
                </a>
              </div>
            </div>
          ) : (
            <form
              onSubmit={handlePublish}
              className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4 pb-28 pb-safe"
            >
              {/* Preview */}
              <div
                className={`relative mx-auto w-full overflow-hidden rounded-xl bg-black ${
                  isShort ? "max-w-[240px] aspect-[9/16]" : "aspect-video"
                }`}
              >
                {previewUrl ? (
                  <video
                    src={previewUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="w-full h-full grid place-items-center text-xs text-zinc-500">
                    No preview
                  </div>
                )}
              </div>

              {/* Real upload progress */}
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 p-3.5">
                <div className="flex items-center justify-between gap-3 text-xs font-semibold">
                  <span className="inline-flex items-center gap-2 min-w-0">
                    {uploadState === "uploading" && (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-red-500 shrink-0" />
                        <span className="truncate">Uploading…</span>
                      </>
                    )}
                    {uploadState === "processing" && (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-amber-500 shrink-0" />
                        <span className="truncate">Processing…</span>
                      </>
                    )}
                    {uploadState === "ready" && (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                        <span className="truncate">Ready to publish</span>
                      </>
                    )}
                    {uploadState === "publishing" && (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-red-500 shrink-0" />
                        <span className="truncate">Publishing…</span>
                      </>
                    )}
                    {(uploadState === "error" || uploadState === "cancelled") && (
                      <>
                        <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                        <span className="truncate text-red-500">
                          {uploadState === "cancelled" ? "Cancelled" : "Upload failed"}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="tabular-nums text-zinc-500 shrink-0">
                    {uploadState === "ready" ? "100%" : `${pct}%`}
                  </span>
                </div>

                <div className="mt-2 h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      uploadState === "error" || uploadState === "cancelled"
                        ? "bg-red-500"
                        : uploadState === "ready" || uploadState === "publishing"
                        ? "bg-emerald-500"
                        : "bg-red-600"
                    }`}
                    style={{
                      width: `${uploadState === "ready" || uploadState === "publishing" ? 100 : pct}%`,
                    }}
                  />
                </div>

                {progress && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 tabular-nums">
                    <span>
                      {formatBytes(progress.uploadedBytes)} / {formatBytes(progress.totalBytes)}
                    </span>
                    {progress.bytesPerSecond && uploadState === "uploading" && (
                      <span>{formatBytes(progress.bytesPerSecond)}/s</span>
                    )}
                    {uploadState === "uploading" && secondsToEta(progress.etaSeconds) && (
                      <span>{secondsToEta(progress.etaSeconds)}</span>
                    )}
                  </div>
                )}

                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {busy && (
                    <button
                      type="button"
                      onClick={cancelUpload}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 text-[11px] font-semibold"
                    >
                      <Ban className="w-3.5 h-3.5" />
                      Cancel
                    </button>
                  )}
                  {(uploadState === "error" || uploadState === "cancelled") && (
                    <button
                      type="button"
                      onClick={retryUpload}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-600 text-white text-[11px] font-semibold"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                      Retry upload
                    </button>
                  )}
                </div>
              </div>

              {errorMessage && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-500 font-medium">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Details */}
              <div>
                <label className="block text-xs font-semibold mb-1.5">Title</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Add a title that describes your video"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1.5">Description</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Tell viewers about your video"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
                />
              </div>

              {/* Thumbnail — long videos and Shorts */}
              <div>
                <label className="block text-xs font-semibold mb-1.5">Thumbnail</label>
                <p className="text-[11px] text-zinc-500 mb-2">
                  {isShort
                    ? "Pick a frame from your Short or upload an image. This is what viewers see in the feed."
                    : "Recommended: 1280×720 (16:9). JPG, PNG or WebP."}
                </p>
                <div className="flex items-start gap-3">
                  <div
                    className={`shrink-0 rounded-lg overflow-hidden bg-zinc-900 grid place-items-center ${
                      isShort ? "w-20 aspect-[9/16]" : "w-28 aspect-video"
                    }`}
                  >
                    {thumbnailUrl ? (
                      <img
                        src={thumbnailUrl}
                        alt="Thumbnail preview"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-[10px] text-zinc-500 px-1 text-center">
                        {busy ? "Generating…" : "No thumbnail"}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={() => thumbInputRef.current?.click()}
                      disabled={thumbBusy}
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-medium disabled:opacity-60 cursor-pointer"
                    >
                      {thumbBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ImageIcon className="w-3.5 h-3.5" />
                      )}
                      {thumbnailUrl ? "Upload image" : "Upload image"}
                    </button>
                    {previewUrl && (
                      <button
                        type="button"
                        disabled={thumbBusy}
                        onClick={async () => {
                          setThumbBusy(true);
                          try {
                            const el = frameVideoRef.current;
                            const fileThumb = el
                              ? await captureVideoFrame(el, frameTime)
                              : await captureVideoFrame(previewUrl, frameTime);
                            if (!fileThumb) {
                              showToast("Could not capture that frame. Try another moment.", "error");
                              return;
                            }
                            setThumbnailFile(fileThumb);
                            if (thumbnailObjectUrlRef.current) URL.revokeObjectURL(thumbnailObjectUrlRef.current);
                            const url = URL.createObjectURL(fileThumb);
                            thumbnailObjectUrlRef.current = url;
                            setThumbnailUrl(url);
                            showToast("Thumbnail captured from video", "success");
                          } finally {
                            setThumbBusy(false);
                          }
                        }}
                        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-xs font-medium disabled:opacity-60 cursor-pointer"
                      >
                        Use this frame
                      </button>
                    )}
                  </div>
                </div>
                {previewUrl && (
                  <div className="mt-3">
                    <p className="text-[11px] text-zinc-500 mb-1.5">
                      Drag to choose a frame
                    </p>
                    <video
                      ref={frameVideoRef}
                      src={previewUrl}
                      muted
                      playsInline
                      preload="metadata"
                      className={`rounded-lg bg-black object-contain ${
                        isShort ? "h-40 aspect-[9/16]" : "w-full max-h-40 aspect-video"
                      }`}
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        const t = Math.min(1, Math.max(0.1, (v.duration || 1) * 0.1));
                        setFrameTime(t);
                        try {
                          v.currentTime = t;
                        } catch {
                          /* ignore */
                        }
                      }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0.1, duration || 1)}
                      step={0.1}
                      value={frameTime}
                      aria-label="Thumbnail frame"
                      onChange={(e) => {
                        const t = Number(e.target.value);
                        setFrameTime(t);
                        const v = frameVideoRef.current;
                        if (v) {
                          try {
                            v.currentTime = t;
                          } catch {
                            /* ignore */
                          }
                        }
                      }}
                      className="w-full mt-2 accent-red-600 cursor-pointer"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1.5">Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
                  >
                    {VIDEO_CATEGORIES.filter((c) => c !== "All").map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5">
                    Add to playlist
                  </label>
                  <select
                    value={playlistId}
                    onChange={(e) => setPlaylistId(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
                  >
                    <option value="">None</option>
                    {playlists.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1.5">
                  Tags (comma separated)
                </label>
                <input
                  type="text"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="tutorial, travel, music"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1.5">Visibility</label>
                <div className="space-y-2">
                  {(
                    [
                      { id: "public", label: "Public", desc: "Everyone can watch", icon: Globe },
                      { id: "unlisted", label: "Unlisted", desc: "Anyone with the link", icon: Link2 },
                      { id: "private", label: "Private", desc: "Only you", icon: Lock },
                    ] as const
                  ).map((opt) => {
                    const Icon = opt.icon;
                    return (
                      <label
                        key={opt.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer ${
                          visibility === opt.id
                            ? "border-red-500 bg-red-500/5"
                            : "border-zinc-200 dark:border-zinc-800"
                        }`}
                      >
                        <input
                          type="radio"
                          name="visibility"
                          checked={visibility === opt.id}
                          onChange={() => setVisibility(opt.id)}
                          className="accent-red-600 w-4 h-4"
                        />
                        <Icon className="w-4 h-4 text-zinc-400 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold">{opt.label}</span>
                          <span className="block text-[11px] text-zinc-500">{opt.desc}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1.5">Publish</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPublishMode("now")}
                    className={`h-10 rounded-lg border text-sm font-medium cursor-pointer ${
                      publishMode === "now"
                        ? "border-red-600 text-red-600 bg-red-50 dark:bg-red-500/10"
                        : "border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    Publish now
                  </button>
                  <button
                    type="button"
                    onClick={() => setPublishMode("schedule")}
                    className={`h-10 rounded-lg border text-sm font-medium cursor-pointer ${
                      publishMode === "schedule"
                        ? "border-red-600 text-red-600 bg-red-50 dark:bg-red-500/10"
                        : "border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    Schedule
                  </button>
                </div>
                {publishMode === "schedule" && (
                  <div className="mt-3">
                    <label className="block text-xs text-zinc-500 mb-1.5">
                      Local date and time
                    </label>
                    <input
                      type="datetime-local"
                      value={scheduleLocal}
                      min={new Date(Date.now() + 60_000 - new Date().getTimezoneOffset() * 60_000)
                        .toISOString()
                        .slice(0, 16)}
                      onChange={(e) => setScheduleLocal(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm"
                    />
                    <p className="text-[11px] text-zinc-500 mt-1.5">
                      Your local time is converted to UTC and published by the server.
                      Until then, the upload stays private.
                    </p>
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2 z-10">
                <button
                  type="button"
                  onClick={closeEverything}
                  className="px-4 py-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploadState !== "ready"}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-semibold shadow"
                >
                  {uploadState === "publishing" && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  )}
                  {uploadState === "publishing" ? "Publishing…" : "Publish"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
