import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AppProvider } from "@/context/AppContext";
import { AppShell } from "@/components/Navigation";
import { GlobalModals } from "@/components/Modals";
import { MiniPlayerProvider } from "@/components/MiniPlayer";

/**
 * Never prerender/cache the HTML shell. The authentication UI must always be
 * the freshly deployed bundle, and every page reads session-derived data.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "BharatTube",
  description: "BharatTube — video streaming and sharing platform.",
  applicationName: "BharatTube",
  appleWebApp: {
    capable: true,
    title: "BharatTube",
    statusBarStyle: "black-translucent",
    startupImage: ["/icon.png"],
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [{ url: "/icon.png", type: "image/png" }],
    shortcut: ["/icon.png"],
    apple: [{ url: "/icon.png" }],
  },
};

/**
 * Mobile-first viewport. `viewportFit: cover` + CSS env() insets keep controls
 * clear of notches and the Android/iOS system navigation areas.
 * `maximumScale` is intentionally not locked so users can still zoom (a11y).
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0F0F0F" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-50 dark:bg-[#0F0F0F] text-zinc-900 dark:text-[#F1F1F1] antialiased selection:bg-red-600 selection:text-white">
        <AppProvider>
          <MiniPlayerProvider>
            <AppShell>{children}</AppShell>
            <GlobalModals />
          </MiniPlayerProvider>
        </AppProvider>
      </body>
    </html>
  );
}
