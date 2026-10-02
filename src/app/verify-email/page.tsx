"use client";

import React, { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2, CheckCircle2, AlertCircle, MailCheck } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { useApp } from "@/context/AppContext";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const { refreshUser } = useApp();

  const [state, setState] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    const verify = async () => {
      if (!token) {
        setState("error");
        setMessage("This verification link is invalid or has expired.");
        return;
      }

      const { ok, data } = await apiFetch("/api/auth", {
        method: "POST",
        body: JSON.stringify({ action: "verify_email", token }),
      });

      if (cancelled) return;

      if (ok && data?.success) {
        setState("success");
        setMessage(data.message || "Email verified successfully.");
        await refreshUser();
      } else {
        setState("error");
        setMessage(data?.error || "This verification link is invalid or has expired.");
      }
    };

    verify();
    return () => {
      cancelled = true;
    };
  }, [token, refreshUser]);

  return (
    <div className="min-h-[calc(100vh-8rem)] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-8 text-center">
        {state === "loading" ? (
          <>
            <Loader2 className="w-10 h-10 text-red-600 animate-spin mx-auto mb-4" />
            <h1 className="text-lg font-bold">Verifying your email...</h1>
          </>
        ) : state === "success" ? (
          <>
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
            <h1 className="text-lg font-bold">Email verified</h1>
            <p className="text-sm text-zinc-500 mt-1.5">{message}</p>
            <Link
              href="/"
              className="mt-6 inline-block px-5 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
            >
              Continue to BharatTube
            </Link>
          </>
        ) : (
          <>
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h1 className="text-lg font-bold">Verification failed</h1>
            <p className="text-sm text-zinc-500 mt-1.5">{message}</p>
            <div className="mt-6 flex items-center justify-center gap-2">
              <Link
                href="/settings"
                className="px-5 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium inline-flex items-center gap-2"
              >
                <MailCheck className="w-4 h-4" />
                <span>Resend from Settings</span>
              </Link>
              <Link
                href="/"
                className="px-5 py-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800 text-sm font-semibold"
              >
                Home
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailContent />
    </Suspense>
  );
}
