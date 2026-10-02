"use client";

import React, { useState, useEffect } from "react";
import { X } from "lucide-react";
import { AuthForm, AuthTab } from "./AuthForm";
import { BrandLogo } from "./BrandLogo";
import { useApp } from "@/context/AppContext";

export function AuthModal({ onClose }: { onClose: () => void }) {
  const { authModalInitialTab } = useApp();
  const [tab, setTab] = useState<AuthTab>(authModalInitialTab);

  useEffect(() => {
    setTab(authModalInitialTab);
  }, [authModalInitialTab]);

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={tab === "login" ? "Sign in" : "Create account"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto overscroll-contain rounded-t-2xl sm:rounded-2xl bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 shadow-2xl pb-safe">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2.5">
            <BrandLogo size={30} className="shrink-0" />
            <div>
              <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
                {tab === "login" ? "Sign in to BharatTube" : "Create your account"}
              </h2>
              <p className="text-[11px] text-zinc-500">
                Google or email — no username required to get started
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-full text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Email/password signup removed — Google is the only login method,
            so the Sign In / Create Account tabs are no longer shown. */}
        <div className="p-6">
          <AuthForm tab="login" onSuccess={onClose} />
        </div>
      </div>
    </div>
  );
}
