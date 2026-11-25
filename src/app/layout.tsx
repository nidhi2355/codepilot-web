import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CodePilot — From Issue to Pull Request",
  description:
    "Describe any GitHub issue—CodePilot indexes your codebase, writes the fix, verifies it with pytest, and opens a clean pull request.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-[var(--bg)] font-sans text-[var(--text)] antialiased selection:bg-[var(--brand-tint)] selection:text-[var(--brand)]`}
      >
        {children}
      </body>
    </html>
  );
}