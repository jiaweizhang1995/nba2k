import type { Metadata } from "next";
import "./globals.css";
import { SaveProvider } from "@/components/save-context";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "HARDWOOD GM — 职业篮球经理模拟",
  description: "原创品牌职业篮球 GM 模拟器：交易、薪资管理、选秀、自由市场与赛季模拟（演示数据）",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <SaveProvider>
          <AppShell>{children}</AppShell>
        </SaveProvider>
      </body>
    </html>
  );
}
