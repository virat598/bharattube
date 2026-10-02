"use client";

import React from "react";
import { Lock } from "lucide-react";
import { useApp } from "@/context/AppContext";

/**
 * Gate for authenticated-only screens.
 * Uses BOTH authStatus and the user object so a just-completed Sign In
 * (which sets user synchronously via applySessionUser) never shows the
 * lock screen while a background refresh is still in flight.
 */
export function ProtectedRoute({
  children,
  title = "Sign in required",
  description = "This area stores private account data. Sign in to continue.",
}: {
  children: React.ReactNode;
  title?: string;
  description?: string;
}) {
  const { authStatus, user, openAuthModal } = useApp();

  // Already have a user in memory (fresh login or restored snapshot) → show
  // the account UI immediately. Do not wait on a background refresh.
  if (user) {
    return <>{children}</>;
  }

  if (authStatus === "loading") {
    return (
      <div className="max-w-3xl mx-auto px-6 py-20">
        <div className="flex flex-col items-center gap-3 text-sm text-zinc-500">
          <div className="w-9 h-9 rounded-full border-2 border-zinc-300 dark:border-zinc-700 border-t-red-600 animate-spin" />
          <span>Loading your account...</span>
        </div>
        <div className="mt-8 space-y-3 animate-pulse">
          <div className="h-40 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-24 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-24 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-6 py-16">
      <div className="flex flex-col items-center text-center p-8 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-800 bg-zinc-100/50 dark:bg-zinc-900/40">
        <div className="w-14 h-14 rounded-2xl bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center text-red-500 mb-4">
          <Lock className="w-7 h-7" />
        </div>
        <h2 className="text-lg font-bold">{title}</h2>
        <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400 max-w-md">
          {description}
        </p>
        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => openAuthModal("login")}
            className="px-5 py-2.5 rounded-full bg-red-600 hover:bg-red-500 text-white text-sm font-semibold shadow cursor-pointer"
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => openAuthModal("signup")}
            className="px-5 py-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm font-semibold cursor-pointer"
          >
            Create Account
          </button>
        </div>
      </div>
    </div>
  );
}
