/**
 * Maps the real Mongo/Express comment payload onto the shape the UI renders.
 * Backend shape (probed live):
 *   { _id, video, user:{_id,name,profilePhoto,username?}, text, parentComment,
 *     likes[], likesCount, repliesCount, replies[] }
 * Missing author.username must never crash the comments sheet.
 */

export interface AdaptedComment {
  id: string;
  videoId: string;
  userId: string;
  parentId: string | null;
  content: string;
  likesCount: number;
  repliesCount: number;
  createdAt: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  };
  replies: AdaptedComment[];
}

function str(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

export function adaptComment(
  raw: unknown,
  videoId: string,
  parentFallback: string | null = null
): AdaptedComment | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, any>;
  const id = str(c._id, c.id);
  if (!id) return null;

  const user = (c.user && typeof c.user === "object" ? c.user : {}) as Record<string, any>;
  const displayName = str(user.name, user.displayName, user.username, "BharatTube user");
  const username = str(user.username, user.handle, displayName).replace(/\s+/g, "").toLowerCase() || "user";
  const parentId = c.parentComment
    ? str(c.parentComment?._id ?? c.parentComment)
    : parentFallback;

  const nested = Array.isArray(c.replies)
    ? c.replies
        .map((r: unknown) => adaptComment(r, videoId, id))
        .filter((r: AdaptedComment | null): r is AdaptedComment => Boolean(r))
    : [];

  return {
    id,
    videoId: str(c.video?._id ?? c.video, videoId),
    userId: str(user._id, user.id, c.user),
    parentId: parentId || null,
    content: str(c.text, c.content, c.message),
    likesCount: Number(
      c.likesCount ?? (Array.isArray(c.likes) ? c.likes.length : 0)
    ),
    repliesCount: Number(c.repliesCount ?? nested.length ?? 0),
    createdAt: str(c.createdAt),
    author: {
      id: str(user._id, user.id),
      username,
      displayName,
      avatarUrl: str(user.profilePhoto, user.avatarUrl, user.avatar) || null,
    },
    replies: nested,
  };
}

export function adaptComments(payload: unknown, videoId: string): AdaptedComment[] {
  if (!payload) return [];
  const root = payload as Record<string, any>;
  const list = Array.isArray(root.comments)
    ? root.comments
    : Array.isArray(root.data?.comments)
    ? root.data.comments
    : Array.isArray(root.data)
    ? root.data
    : Array.isArray(payload)
    ? payload
    : [];

  const adapted: AdaptedComment[] = (list as unknown[]).
    map((c) => adaptComment(c, videoId)).
    filter((c): c is AdaptedComment => Boolean(c));

  const roots = adapted.filter((c) => !c.parentId);
  const children = adapted.filter((c) => c.parentId);
  if (!children.length) return adapted;

  const byParent = new Map<string, AdaptedComment[]>();
  for (const child of children) {
    const key = String(child.parentId);
    const arr = byParent.get(key) || [];
    arr.push(child);
    byParent.set(key, arr);
  }

  return roots.map((root) => ({
    ...root,
    replies: [
      ...(root.replies || []),
      ...(byParent.get(root.id) || []).filter(
        (r) => !(root.replies || []).some((x) => x.id === r.id)
      ),
    ],
  }));
}
