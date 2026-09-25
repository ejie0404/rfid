import type { Metadata } from "next";
import "@smartgate/ui/styles.css";
export const metadata: Metadata = {
  title: "SmartGate · Your home",
  description: "Dependable access. A warmer welcome home.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
