"use client";

/** Capture a JPEG poster frame from a video element or URL at a given time. */
export function captureVideoFrame(
  source: HTMLVideoElement | string,
  timeSeconds?: number
): Promise<File | null> {
  return new Promise((resolve) => {
    const ownsElement = typeof source === "string";
    const video = ownsElement ? document.createElement("video") : source;

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      if (ownsElement) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      resolve(file);
    };

    const snap = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 720;
        canvas.height = video.videoHeight || 1280;
        const ctx = canvas.getContext("2d");
        if (!ctx || !canvas.width || !canvas.height) return finish(null);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) =>
            finish(
              blob
                ? new File([blob], "thumbnail.jpg", { type: "image/jpeg" })
                : null
            ),
          "image/jpeg",
          0.86
        );
      } catch {
        finish(null);
      }
    };

    if (!ownsElement) {
      if (typeof timeSeconds === "number" && Number.isFinite(timeSeconds)) {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          snap();
        };
        video.addEventListener("seeked", onSeeked);
        try {
          video.currentTime = Math.min(
            Math.max(0, timeSeconds),
            Math.max(0, (video.duration || timeSeconds) - 0.05)
          );
        } catch {
          snap();
        }
        return;
      }
      snap();
      return;
    }

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.src = source as string;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const t =
        typeof timeSeconds === "number"
          ? timeSeconds
          : Math.min(1, Math.max(0.1, duration * 0.1));
      try {
        video.currentTime = Math.min(t, Math.max(0, duration - 0.05));
      } catch {
        snap();
      }
    };
    video.onseeked = () => snap();
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
  });
}
