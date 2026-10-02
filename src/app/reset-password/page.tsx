"use client";

import React, { useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Lock, AlertCircle, Check, KeyRound } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { useApp } from "@/context/AppContext";

const PASSWORD_RULES = [
  { id: "length", label: "At least 8 characters", test: (p: string) => p.length >= 8 },
  { id: "letter", label: "One letter", test: (p: string) => /[a-zA-Z]/.test(p) },
  { id: "number", label: "One number", test: (p: string) => /[0-9]/.test(p) },
];

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { showToast } = useApp();

  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const valid = PASSWORD_RULES.every((r) => r.test(password));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError("");

    if (!token) {
      setError("Reset link is missing or invalid.");
      return;
    }
    if (!valid) {
      setError("Your password does not meet the required requirements.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const { ok, data } = await apiFetch("/api/auth", {
        method: "POST",
        body: JSON.stringify({
          action: "reset_password",
          token,
          password,
          confirmPassword,
        }),
      });

      if (!ok || !data?.success) {
        setError(data?.error || "Something went wrong. Please try again.");
        return;
      }

      showToast(
        data.message || "Password updated. Please sign in with your new password.",
        "success"
      );
      router.replace("/login");
    } catch {
      setError("Unable to connect. Please check your internet connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-8rem)] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-red-600" />
          <h1 className="text-lg font-bold">Choose a new password</h1>
        </div>
        <p className="text-xs text-zinc-500 mb-5">
          {token
            ? "This reset link can be used once and expires one hour after it was requested."
            : "This reset link is missing its token. Request a new one to continue."}
        </p>

        {!token ? (
          <Link
            href="/forgot-password"
            className="block w-full py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold text-center"
          >
            Request a new link
          </Link>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-500 font-medium">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                type="password"
                required
                autoFocus
                autoComplete="new-password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800/90 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
              />
            </div>

            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                type="password"
                required
                autoComplete="new-password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800/90 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
              />
            </div>

            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              {PASSWORD_RULES.map((rule) => {
                const passed = rule.test(password);
                return (
                  <span
                    key={rule.id}
                    className={`inline-flex items-center gap-1 ${
                      passed ? "text-emerald-500" : "text-zinc-500"
                    }`}
                  >
                    <Check className={`w-3 h-3 ${passed ? "" : "opacity-30"}`} />
                    {rule.label}
                  </span>
                );
              })}
            </div>

            <button
              type="submit"
              disabled={submitting || !valid}
              className="w-full py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white font-semibold text-sm shadow cursor-pointer inline-flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{submitting ? "Updating password..." : "Update password"}</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  );
}
