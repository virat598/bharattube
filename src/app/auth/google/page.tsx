"use client";

import { useEffect } from "react";
import { googleLoginUrl } from "@/lib/api-config";

export default function AuthGoogleRedirectPage() {
  useEffect(() => {
    window.location.assign(googleLoginUrl());
  }, []);

  return (
    <div className="min-h-[60vh] flex items-center justify-center text-sm text-zinc-500">
      Redirecting to Google...
    </div>
  );
}
