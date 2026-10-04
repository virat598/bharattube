"use client";

import React, { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { googleLoginUrl } from "@/lib/api-config";

export type AuthTab = "login" | "signup";

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M12 10.2v3.6h5.1c-.2 1.2-1.5 3.6-5.1 3.6-3.1 0-5.6-2.5-5.6-5.6S8.9 6.2 12 6.2c1.8 0 3 .7 3.7 1.4l2.5-2.4C16.7 3.7 14.6 2.8 12 2.8 6.9 2.8 2.8 6.9 2.8 12S6.9 21.2 12 21.2c5.2 0 8.6-3.6 8.6-8.7 0-.6-.1-1-.2-1.5H12z"
      />
      <path
        fill="#34A853"
        d="M3.9 7.4l3 2.2C7.8 7.5 9.7 6.2 12 6.2c1.8 0 3 .7 3.7 1.4l2.5-2.4C16.7 3.7 14.6 2.8 12 2.8 8.5 2.8 5.5 4.8 3.9 7.4z"
      />
      <path
        fill="#4A90E2"
        d="M12 21.2c2.5 0 4.6-.8 6.1-2.2l-2.9-2.3c-.8.6-1.9 1-3.2 1-3.5 0-5.9-2.3-6.4-4.5l-3 2.3C4.2 18.9 7.7 21.2 12 21.2z"
      />
      <path
        fill="#FBBC05"
        d="M5.6 13.2c-.2-.6-.3-1.2-.3-1.9s.1-1.3.3-1.9l-3-2.3C2.2 8.4 2 9.6 2 11.3s.2 2.9.6 4.2l3-2.3z"
      />
    </svg>
  );
}

export function AuthForm({
  tab: _tab,
  onTabChange: _onTabChange,
  onSuccess: _onSuccess,
  initialError,
}: {
  tab: AuthTab;
  onTabChange?: (tab: AuthTab) => void;
  onSuccess?: () => void;
  initialError?: string;
}) {
  const [error, setError] = useState(initialError || "");
  const [googleStarting, setGoogleStarting] = useState(false);

  // Sync the incoming `initialError` prop into local state using React's
  // recommended "adjust state during render" pattern. This replaces a
  // setState-in-effect that caused an extra render pass on every mount.
  const [lastInitialError, setLastInitialError] = useState(initialError);
  if (initialError !== lastInitialError) {
    setLastInitialError(initialError);
    setError(initialError || "");
  }

  /**
   * Full-page redirect to the BACKEND's Google OAuth start endpoint.
   * The frontend never implements OAuth itself and never sees any secret.
   */
  const startGoogleLogin = () => {
    if (googleStarting) return;
    setGoogleStarting(true);
    try {
      // A full navigation; the browser takes the user to the backend, which
      // redirects to Google and finally back to /auth/google/callback.
      window.location.assign(googleLoginUrl());
    } catch {
      setGoogleStarting(false);
      setError(
        "We couldn't open Google sign-in. Please check your connection and try again."
      );
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-500 font-medium"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Google: real OAuth only. The whole flow runs on the backend. */}
      <button
        type="button"
        onClick={startGoogleLogin}
        disabled={googleStarting}
        aria-busy={googleStarting}
        aria-label="Continue with Google"
        className="group w-full py-2.5 rounded-xl bg-white dark:bg-zinc-100 border border-zinc-300 dark:border-zinc-200 text-zinc-900 font-semibold text-sm shadow-sm hover:shadow hover:bg-zinc-50 active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2.5 transition-all cursor-pointer"
      >
        {googleStarting ? (
          <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
        ) : (
          <GoogleIcon className="w-5 h-5" />
        )}
        <span>{googleStarting ? "Redirecting to Google…" : "Continue with Google"}</span>
      </button>

    </div>
  );
}
