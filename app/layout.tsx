import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import { getThemeChoice } from "@/lib/design/theme.server";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-archivo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Crazy Larry's Dumpsters — Operations",
  description: "Dumpster rental booking and operations platform.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Explicit override from the cookie, or undefined to let
  // @media (prefers-color-scheme) decide (see globals.css) — read once
  // here, server-side, so there's no flash of the wrong theme on load.
  const theme = getThemeChoice();

  return (
    <html lang="en" className={archivo.variable} data-cl-theme={theme}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
