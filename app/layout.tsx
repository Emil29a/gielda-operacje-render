import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  return {
    metadataBase: new URL(origin),
    title: "Giełda Operacje — dziennik zmian eToro",
    description:
      "Monitoruj dzienne zmiany publicznych portfeli obserwowanych inwestorów eToro w trybie wyłącznie do odczytu.",
    openGraph: {
      title: "Giełda Operacje",
      description: "Bieżący dziennik zmian obserwowanych inwestorów eToro.",
      images: [{ url: `${origin}/og.png`, width: 1731, height: 909 }],
      locale: "pl_PL",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "Giełda Operacje",
      description: "Bieżący dziennik zmian obserwowanych inwestorów eToro.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
