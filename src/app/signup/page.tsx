"use client";

import React, { useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { useApp } from "@/context/AppContext";
import { BrandLogo } from "@/components/BrandLogo";

function SignupPageContent() {
  const { user, loadingAuth } = useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";
  const error = searchParams.get("error") || "";

  useEffect(() => {
    if (!loadingAuth && user) {
      router.replace(next);
    }
  }, [loadingAuth, user, next, router]);

  if (loadingAuth) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-zinc-500">
        Checking your session...
      </div>
    );
  }

  if (user) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-zinc-500">
        Already signed in — redirecting...
      </div>
    );
  }

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
          <h1 className="text-lg font-bold mb-1">Create your account</h1>
          <p className="text-xs text-zinc-500 mb-5">
            Use Google or your email. Channel name and @handle can be set later
            in Edit channel — not during sign-up.
          </p>
          <AuthForm
            tab="signup"
            initialError={error}
            onSuccess={() => router.replace(next)}
          />
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageContent />
    </Suspense>
  );
}
