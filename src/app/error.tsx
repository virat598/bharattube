"use client";

import React from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

/**
 * Route-level error boundary. Without it a single render exception anywhere in
 * the app leaves the user with a blank/frozen screen — which looks exactly like
 * "sign in did nothing". The real error is surfaced and logged instead.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("BharatTube route error:", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
        <AlertTriangle className="w-9 h-9 text-red-500 mx-auto mb-3" />
        <h1 className="text-base font-bold">Something went wrong on this screen</h1>
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400 break-words">
          {error.message || "An unexpected error occurred."}
        </p>
        {error.digest && (
          <p className="mt-1 text-[11px] text-zinc-400">Error ID: {error.digest}</p>
        )}
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Try again</span>
          </button>
          <button
            type="button"
            onClick={() => {
              window.location.href = "/";
            }}
            className="px-4 py-2 rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold cursor-pointer"
          >
            Go home
          </button>
        </div>
      </div>
    </div>
  );
}
