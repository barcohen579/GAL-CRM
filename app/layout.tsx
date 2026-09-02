import type { Metadata } from "next";
import { Rubik } from "next/font/google";
import "./globals.css";

// Geist Sans (the original scaffold font) is Latin-only and has no
// Hebrew glyphs — Hebrew text would silently fall back to whatever
// system font each browser/OS happens to pick, which is inconsistent
// and undermines "readable typography." Rubik supports both Latin and
// Hebrew from the same family, so headings, labels and data all render
// in one consistent typeface.
const rubik = Rubik({
  variable: "--font-sans",
  subsets: ["latin", "hebrew"],
});

export const metadata: Metadata = {
  title: "GAL CRM",
  description: "מערכת ניהול לקוחות — Gal Valdman Fitness",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="he"
      dir="rtl"
      className={`${rubik.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
