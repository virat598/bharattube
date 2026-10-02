"use client";

import React from "react";
import Link from "next/link";
import { ArrowLeft, Clock } from "lucide-react";
import { CollectionPage } from "@/components/CollectionPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";

export default function WatchLaterPage() {
  return (
    <ProtectedRoute
      title="Sign in to view Watch Later"
      description="Saved videos are private account data."
    >
      <div className="max-w-5xl mx-auto px-3 sm:px-4 pt-3">
        <Link
          href="/you"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-red-500 mb-1"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          You
        </Link>
      </div>
      <CollectionPage
        title="Watch later"
        subtitle="Videos you saved to watch later"
        icon={<Clock className="w-5 h-5" />}
        feed="watch_later"
        layout="list"
        removeMode="watch_later"
        emptyTitle="No videos saved for later"
        emptyDescription='Use the "Watch Later" button on any video to build your queue.'
      />
    </ProtectedRoute>
  );
}
