import type { Metadata, Viewport } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { COLOR_MODE_BOOTSTRAP_SCRIPT } from "@/lib/color-mode";

/**
 * Geist + a violet accent is the default look of a particular starter stack,
 * which is most of why the app read as generated. Inter Tight is the same
 * class of neutral grotesque with tighter spacing and a little more character
 * at the small sizes this UI is mostly made of, and it carries the 550 weight
 * the type scale asks for.
 */
const uiSans = Inter_Tight({
  variable: "--font-ui-sans",
  subsets: ["latin"],
});

const uiMono = JetBrains_Mono({
  variable: "--font-ui-mono",
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
    { media: "(prefers-color-scheme: light)", color: "#f8f9fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0d" },
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
        className={`${uiSans.variable} ${uiMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
