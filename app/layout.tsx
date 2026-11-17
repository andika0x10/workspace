import type { Metadata } from "next";
import "./globals.css";
import "@fontsource/instrument-sans/latin-400.css";
import "@fontsource/instrument-sans/latin-500.css";
import "@fontsource/instrument-sans/latin-600.css";
import "@fontsource/instrument-sans/latin-700.css";
import "@fontsource/instrument-sans/latin-400-italic.css";
import "@fontsource/instrument-sans/latin-700-italic.css";

export const metadata: Metadata = {
  title: "Workspace — Ruang untuk ide dan pekerjaan",
  description: "Note dan task, bebas kamu susun.",
  icons: { icon: { url: "/logo.svg?v=2", type: "image/svg+xml" } },
  robots: { index: false, follow: false },
};
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
