"use client";

import React from "react";
import { Upload, Video, Flame, X, Radio } from "lucide-react";
import { useApp } from "@/context/AppContext";

export type CreateMode = "upload" | "record" | "short";

/**
 * YouTube-style Create menu.
 * Bottom sheet on phones, centred dialog on desktop.
 *
 * "Go Live" is intentionally NOT rendered: this deployment has no live
 * ingest backend (no RTMP/HLS service, no live session model), so showing it
 * would be a dead button. It appears automatically if a live backend is added.
 */
const LIVE_STREAMING_SUPPORTED = false;

export function CreateSheet({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (mode: CreateMode) => void;
}) {
  const { showToast } = useApp();

  const options: Array<{
    mode: CreateMode;
    icon: React.ReactNode;
    title: string;
    description: string;
  }> = [
    {
      mode: "upload",
      icon: <Upload className="w-5 h-5" />,
      title: "Upload a video",
      description: "Choose a video from your device",
    },
    {
      mode: "record",
      icon: <Video className="w-5 h-5" />,
      title: "Record a video",
      description: "Record using your camera",
    },
    {
      mode: "short",
      icon: <Flame className="w-5 h-5" />,
      title: "Create a Short",
      description: "Record or pick a vertical video",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Create"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 shadow-lg pb-safe">
        {/* Grab handle (mobile affordance) */}
        <div className="sm:hidden flex justify-center pt-2.5 pb-1">
          <span className="h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>

        <div className="flex items-center justify-between pl-5 pr-3 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-base font-semibold">Create</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="tap-target inline-flex items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-2">
          {options.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              onClick={() => onSelect(opt.mode)}
              className="w-full flex items-center gap-4 px-3 min-h-[60px] py-2.5 rounded-lg text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <span className="w-10 h-10 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 flex items-center justify-center">
                {opt.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-medium text-zinc-900 dark:text-zinc-100">
                  {opt.title}
                </span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                  {opt.description}
                </span>
              </span>
            </button>
          ))}

          {LIVE_STREAMING_SUPPORTED && (
            <button
              type="button"
              onClick={() => showToast("Live streaming is starting…", "info")}
              className="w-full flex items-center gap-4 px-3 py-3.5 rounded-xl text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="w-11 h-11 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800 text-red-600 flex items-center justify-center">
                <Radio className="w-5 h-5" />
              </span>
              <span>
                <span className="block text-sm font-semibold">Go live</span>
                <span className="block text-xs text-zinc-500">
                  Start a live broadcast
                </span>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
