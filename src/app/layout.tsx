import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workena — evidencia práce",
  description: "Prehľadná evidencia práce pre váš tím.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sk">
      <body>{children}</body>
    </html>
  );
}
