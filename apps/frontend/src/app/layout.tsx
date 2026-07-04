import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { THEME_BOOT_SCRIPT } from "../lib/theme";

export const metadata: Metadata = {
  title: "Zoft AI Workflow Copilot",
  description: "Build workflows through natural language.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
