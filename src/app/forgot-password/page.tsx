"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Loader2, Mail, CheckCircle2, AlertCircle, KeyRound } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { BrandLogo } from "@/components/BrandLogo";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    message: string;
    resetLink?: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError("");

    if (!EMAIL_RE.test(email.trim().toLowerCase())) {
      setError("Please enter a valid email address.");
      return;
    }

    setSubmitting(true);
    try {
      const { ok, status, data } = await apiFetch("/api/auth", {
        method: "POST",
        body: JSON.stringify({ action: "forgot_password", email: email.trim() }),
      });

      if (!ok) {
        setError(
          data?.error ||
            (status >= 500
              ? "Something went wrong. Please try again."
              : "Unable to connect. Please check your internet connection and try again.")
        );
        return;
      }

      setResult({
        message: data.message || "Check your email for password reset instructions.",
        resetLink: data.resetLink,
      });
    } catch {
      setError("Unable to connect. Please check your internet connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-8rem)] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center justify-center gap-2 mb-6">
          <BrandLogo size={34} className="shrink-0" />
          <span className="font-bold text-xl tracking-tight">
            Bharat<span className="text-red-600">Tube</span>
          </span>
        </Link>

        <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-6">
          <div className="flex items-center gap-2 mb-1">
            <KeyRound className="w-4 h-4 text-red-600" />
            <h1 className="text-lg font-bold">Reset your password</h1>
          </div>
          <p className="text-xs text-zinc-500 mb-5">
            Enter the email address of your account. We&apos;ll create a secure,
            single-use reset link that expires in one hour.
          </p>

          {result ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{result.message}</span>
              </div>

              {result.resetLink && (
                <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 mb-1.5">
                    Your reset link
                  </div>
                  <Link
                    href={result.resetLink}
                    className="text-xs text-red-500 font-semibold break-all hover:underline"
                  >
                    {result.resetLink}
                  </Link>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Link
                  href={result.resetLink || "/login"}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold text-center"
                >
                  {result.resetLink ? "Continue to reset" : "Back to sign in"}
                </Link>
                <button
                  type="button"
                  onClick={() => setResult(null)}
                  className="px-4 py-2.5 rounded-xl bg-zinc-200 dark:bg-zinc-800 text-sm font-semibold cursor-pointer"
                >
                  Another email
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              {error && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-500 font-medium">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  type="email"
                  required
                  autoFocus
                  placeholder="Email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800/90 border border-zinc-300 dark:border-zinc-700 text-sm focus:outline-none focus:border-red-500"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white font-semibold text-sm shadow cursor-pointer inline-flex items-center justify-center gap-2"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{submitting ? "Sending reset link..." : "Send reset link"}</span>
              </button>
            </form>
          )}

          <div className="mt-5 text-center text-xs text-zinc-500">
            Remembered it?{" "}
            <Link href="/login" className="text-red-500 font-semibold hover:underline">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
