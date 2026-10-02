"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Circle,
  Square,
  RefreshCw,
  Check,
  AlertCircle,
  SwitchCamera,
  Image as ImageIcon,
} from "lucide-react";

/**
 * Real device camera recording via getUserMedia + MediaRecorder.
 * Handles permission denial, missing hardware, and unsupported browsers with
 * explicit states instead of failing silently.
 */
export function CameraRecorder({
  vertical,
  onCancel,
  onUse,
  onPickGallery,
}: {
  /** Shorts prefer a portrait capture. */
  vertical: boolean;
  onCancel: () => void;
  onUse: (file: File, previewUrl: string, durationSec: number) => void;
  onPickGallery?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const [status, setStatus] = useState<
    "requesting" | "ready" | "recording" | "preview" | "error"
  >("requesting");
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  const [preview, setPreview] = useState<{ url: string; file: File; duration: number } | null>(
    null
  );

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    setStatus("requesting");
    setError("");
    stopStream();

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError(
        "Your browser does not support camera recording. Try uploading a video from your device instead."
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facing,
          width: { ideal: vertical ? 720 : 1280 },
          height: { ideal: vertical ? 1280 : 720 },
        },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        await videoRef.current.play().catch(() => {});
      }
      setStatus("ready");
    } catch (err) {
      const e = err as DOMException;
      setStatus("error");
      if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
        setError(
          "Camera permission was denied. Allow camera access in your browser settings, then try again."
        );
      } else if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") {
        setError("No camera was found on this device.");
      } else if (e?.name === "NotReadableError") {
        setError("Your camera is already in use by another app.");
      } else {
        setError("Could not start the camera. Please try again.");
      }
    }
  }, [facing, vertical, stopStream]);

  useEffect(() => {
    // Start the camera asynchronously (after the current commit) so the
    // effect does not call setState synchronously — avoids a cascading render.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) startCamera();
    });
    return () => {
      cancelled = true;
      stopStream();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startCamera, stopStream]);

  // Release the preview object URL when it is replaced or the view closes.
  useEffect(() => {
    return () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    };
  }, [preview?.url]);

  const pickMimeType = () => {
    const candidates = [
      "video/mp4;codecs=h264,aac",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    for (const c of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
        return c;
      }
    }
    return "";
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) return;
    if (typeof MediaRecorder === "undefined") {
      setStatus("error");
      setError("Recording is not supported in this browser. Please upload a file instead.");
      return;
    }

    chunksRef.current = [];
    const mimeType = pickMimeType();
    // Bitrate must match the resolution we actually capture (720p in both
    // orientations). Left unset, browsers fall back to a much higher default
    // (~8 Mbps in Chrome), which makes the recording several times larger than
    // the same footage recorded by the device camera — so the file that leaves
    // the browser is far bigger than what was captured.
    const recorder = mimeType
      ? new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: vertical ? 3500000 : 4000000,
          audioBitsPerSecond: 128000,
        })
      : new MediaRecorder(stream);

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `recording-${Date.now()}.${ext}`, { type });
      const url = URL.createObjectURL(blob);
      const duration = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      setPreview({ url, file, duration });
      setStatus("preview");
      stopStream();
    };

    recorderRef.current = recorder;
    recorder.start(1000);
    startedAtRef.current = Date.now();
    setSeconds(0);
    setStatus("recording");
    timerRef.current = setInterval(() => {
      setSeconds(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 500);
  };

  const stopRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current?.stop();
  };

  const retake = () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setSeconds(0);
    startCamera();
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60
  ).padStart(2, "0")}`;

  return (
    <div className="fixed inset-0 z-[80] bg-black flex flex-col">
      <div className="flex items-center justify-between px-3 py-2.5 pt-safe text-white shrink-0">
        <button
          type="button"
          onClick={() => {
            stopStream();
            onCancel();
          }}
          aria-label="Close camera"
          className="tap-target inline-flex items-center justify-center rounded-full bg-black/50"
        >
          <X className="w-5 h-5" />
        </button>
        <span className="text-sm font-semibold">
          {status === "recording" ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse" />
              {mmss}
            </span>
          ) : status === "preview" ? (
            "Preview"
          ) : vertical ? (
            "Record a Short"
          ) : (
            "Record a video"
          )}
        </span>
        {status === "ready" ? (
          <button
            type="button"
            onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
            aria-label="Switch camera"
            className="tap-target inline-flex items-center justify-center rounded-full bg-black/50"
          >
            <SwitchCamera className="w-5 h-5" />
          </button>
        ) : (
          <span className="w-11" />
        )}
      </div>

      <div className="flex-1 min-h-0 relative flex items-center justify-center">
        {status === "error" ? (
          <div className="max-w-sm mx-auto px-6 text-center">
            <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
            <p className="text-sm text-zinc-200">{error}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={startCamera}
                className="px-4 py-2.5 rounded-full bg-red-600 text-white text-xs font-semibold cursor-pointer"
              >
                Try again
              </button>
              {onPickGallery && (
                <button
                  type="button"
                  onClick={onPickGallery}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white text-xs font-semibold cursor-pointer"
                >
                  <ImageIcon className="w-4 h-4" />
                  <span>Select from Gallery</span>
                </button>
              )}
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2.5 rounded-full bg-zinc-800 text-white text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : status === "preview" && preview ? (
          <video
            src={preview.url}
            controls
            playsInline
            className="max-h-full max-w-full"
          />
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              className={`max-h-full max-w-full ${
                facing === "user" ? "-scale-x-100" : ""
              }`}
            />
            {status === "requesting" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70 text-sm text-zinc-300 px-6 text-center">
                <span>Waiting for camera permission…</span>
                {onPickGallery && (
                  <button
                    type="button"
                    onClick={onPickGallery}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-700 text-white text-xs font-semibold cursor-pointer"
                  >
                    <ImageIcon className="w-4 h-4" />
                    <span>Upload from Gallery instead</span>
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 pb-safe px-6 py-5 flex items-center justify-center gap-8">
        {(status === "ready" || status === "error") && onPickGallery && (
          <button
            type="button"
            onClick={onPickGallery}
            aria-label="Choose video from gallery"
            className="flex flex-col items-center gap-1 text-white active:scale-95 transition-transform cursor-pointer"
          >
            <span className="w-12 h-12 rounded-xl bg-zinc-800/90 hover:bg-zinc-700 border border-white/25 flex items-center justify-center shadow-lg">
              <ImageIcon className="w-5 h-5 text-white" />
            </span>
            <span className="text-[11px] font-semibold text-zinc-200">Gallery</span>
          </button>
        )}

        {status === "ready" && (
          <button
            type="button"
            onClick={startRecording}
            aria-label="Start recording"
            className="w-16 h-16 rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform cursor-pointer"
          >
            <Circle className="w-10 h-10 fill-red-600 text-red-600" />
          </button>
        )}

        {(status === "ready" || status === "error") && onPickGallery && (
          <button
            type="button"
            onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
            aria-label="Flip camera"
            className="flex flex-col items-center gap-1 text-white active:scale-95 transition-transform cursor-pointer"
          >
            <span className="w-12 h-12 rounded-full bg-zinc-800/90 hover:bg-zinc-700 border border-white/20 flex items-center justify-center">
              <SwitchCamera className="w-5 h-5 text-white" />
            </span>
            <span className="text-[11px] font-semibold text-zinc-200">Flip</span>
          </button>
        )}

        {status === "recording" && (
          <button
            type="button"
            onClick={stopRecording}
            aria-label="Stop recording"
            className="w-16 h-16 rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform"
          >
            <Square className="w-7 h-7 fill-red-600 text-red-600" />
          </button>
        )}

        {status === "preview" && preview && (
          <>
            <button
              type="button"
              onClick={retake}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-zinc-800 text-white text-sm font-semibold active:scale-95"
            >
              <RefreshCw className="w-4 h-4" />
              Retake
            </button>
            <button
              type="button"
              onClick={() => onUse(preview.file, preview.url, preview.duration)}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-red-600 text-white text-sm font-semibold active:scale-95"
            >
              <Check className="w-4 h-4" />
              Use video
            </button>
          </>
        )}
      </div>
    </div>
  );
}
