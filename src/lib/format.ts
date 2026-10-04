export function formatDuration(seconds: number): string {
  if (!seconds || Number.isNaN(seconds) || seconds < 0) return "0:00";
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(
      2,
      "0"
    )}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function formatCount(count: number, singular?: string, plural?: string): string {
  const num = Number(count || 0);
  let formatted = String(num);
  if (num >= 1_000_000) {
    formatted = `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  } else if (num >= 1_000) {
    formatted = `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }

  if (singular && plural) {
    return `${formatted} ${num === 1 ? singular : plural}`;
  }
  return formatted;
}

export function formatTimeAgo(dateInput: string | Date): string {
  if (!dateInput) return "";
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));

  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12)
    return `${diffMonth} month${diffMonth === 1 ? "" : "s"} ago`;
  const diffYr = Math.floor(diffMonth / 12);
  return `${diffYr} year${diffYr === 1 ? "" : "s"} ago`;
}

export const VIDEO_CATEGORIES = [
  "All",
  "Music",
  "Gaming",
  "Live",
  "News",
  "Sports",
  "Education",
  "Technology",
  "Entertainment",
  "Comedy",
];
