import type { Metadata } from "next";
import "./globals.css";

// Rendered per request so every page carries the CSP nonce from proxy.ts (static pages would have none).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MediSync",
  description: "Cross-EHR record transfer and outside-record reconciliation. Synthetic data only.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Plain Google Fonts link (not next/font) so the static demo snapshot can load the same faces. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- root layout applies to every page */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
