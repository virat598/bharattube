"use client";

import React from "react";
import Link from "next/link";
import { ArrowLeft, History } from "lucide-react";
import { CollectionPage } from "@/components/CollectionPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";

export default function HistoryPage() {
  return (
    <ProtectedRoute
      title="Sign in to view your watch history"
      description="Watch history is private account data stored against your user ID."
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
        title="History"
        subtitle="Videos you watched, with resume position when available"
        icon={<History className="w-5 h-5" />}
        feed="history"
        layout="list"
        removeMode="history"
        allowClearAll
        emptyTitle="Your watch history is empty"
        emptyDescription="Videos you watch will show up here."
      />
    </ProtectedRoute>
  );
}
