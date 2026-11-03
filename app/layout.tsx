import "./globals.css";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "Bounded Image Archive",
  description:
    "Build a resource-bounded ZIP from images referenced by a public HTML page.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
