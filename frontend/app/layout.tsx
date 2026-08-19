import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ExtensionMeta } from "@/components/extension-meta";
import { COLOR_MODE_BOOTSTRAP_SCRIPT } from "@/lib/color-mode";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Watch Together",
  description: "Synchronized video watching with friends",
  icons: {
    icon: "/favicon.svg",
    apple: "/logo.svg",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `data-theme` is deliberately not rendered here: the inline script below is
    // its only writer, so React can never clobber it while hydrating. Until the
    // script runs, the dark tokens in `:root` apply.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applies the stored (or OS) colour scheme before the first paint so the
          page never flashes the wrong one.
        */}
        <script
          dangerouslySetInnerHTML={{ __html: COLOR_MODE_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ExtensionMeta />
        {children}
      </body>
    </html>
  );
}
