/**
 * Explicit nested route for /auth/google/callback.
 *
 * next.config.ts also rewrites this path to /auth/callback (URL unchanged),
 * but having a real page here guarantees the route is emitted in the build
 * and can never return a Vercel 404.
 */
export { default } from "@/app/auth/callback/page";
