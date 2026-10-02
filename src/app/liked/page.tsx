"use client";

import React from "react";
import Link from "next/link";
import { ArrowLeft, ThumbsUp } from "lucide-react";
import { CollectionPage } from "@/components/CollectionPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";

export default function LikedVideosPage() {
  return (
    <ProtectedRoute
      title="Sign in to view your liked videos"
      description="Your likes are private account data."
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
        title="Liked videos"
        subtitle="Videos you have liked"
        icon={<ThumbsUp className="w-5 h-5" />}
        feed="liked"
        removeMode="liked"
        layout="list"
        emptyTitle="No liked videos yet"
        emptyDescription="Videos you like will be collected here."
      />
    </ProtectedRoute>
  );
}
