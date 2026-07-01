import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zoft AI Workflow Copilot",
  description: "Build workflows through natural language.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
