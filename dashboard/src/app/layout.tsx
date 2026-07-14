import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = {
  title: `Dialer | ${APP_NAME}`,
  description: "AI voice dialer queue, live calls, call history, and spend.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-canvas text-ink">{children}</body>
    </html>
  );
}
