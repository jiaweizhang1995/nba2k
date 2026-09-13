"use client";

// App shell: sidebar nav + top bar. High-density management-sim layout,
// desktop-first, collapses to icon rail + stacked panels at tablet width.
// 导航分三组：日常主流程 / 球队运作 / 更多（低频与配置），当前页高亮。

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSave, PHASE_LABEL } from "./save-context";

const NAV_GROUPS: { label: string; items: { href: string; label: string; icon: string }[] }[] = [
  {
    label: "日常",
    items: [
      { href: "/gm", label: "总经理首页", icon: "◎" },
      { href: "/sim", label: "比赛推进", icon: "▶" },
      { href: "/roster", label: "轮换与阵容", icon: "☰" },
      { href: "/league", label: "联盟", icon: "≡" },
    ],
  },
  {
    label: "球队运作",
    items: [
      { href: "/trade", label: "交易中心", icon: "⇄" },
      { href: "/freeagency", label: "自由市场", icon: "✍" },
      { href: "/draft", label: "选秀", icon: "✦" },
      { href: "/assets", label: "资产", icon: "▣" },
    ],
  },
  {
    label: "更多",
    items: [
      { href: "/chemistry", label: "化学反应", icon: "♥" },
      { href: "/eval", label: "AI 评测", icon: "★" },
      { href: "/log", label: "操作日志", icon: "⌗" },
      { href: "/settings", label: "设置与数据来源", icon: "⚙" },
      { href: "/", label: "存档管理", icon: "⌂" },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { summary, saveId } = useSave();
  const save = summary?.save;
  const team = summary?.userTeam;
  const isGod = !!save?.godMode;
  const isDemo = save?.dataStatus !== "IMPORTED";

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="flex min-h-screen">
      <aside className="w-14 md:w-44 shrink-0 border-r border-[var(--border)] bg-[var(--bg-panel)] flex flex-col sticky top-0 h-screen overflow-y-auto">
        <div className="px-3 py-4 border-b border-[var(--border)]">
          <div className="text-[13px] font-bold tracking-wider text-[var(--accent)] hidden md:block">HARDWOOD GM</div>
          <div className="text-[10px] text-[var(--text-dim)] hidden md:block">职业篮球经理模拟</div>
        </div>
        <nav className="flex-1 py-2">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label}>
              {gi > 0 && <div className="mx-3 my-2 border-t border-[var(--border)]" />}
              <div className="px-3 md:px-4 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-[var(--text-dim)] hidden md:block">{group.label}</div>
              {group.items.map((n) => {
                const active = isActive(n.href);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`flex items-center gap-3 px-3 md:px-4 py-2.5 text-[13px] hover:bg-[var(--bg-panel2)] ${active ? "bg-[var(--bg-panel2)] text-[var(--accent)] font-semibold border-l-2 border-[var(--accent)]" : "text-[var(--text)] border-l-2 border-transparent"}`}
                    title={n.label}
                  >
                    <span className="text-[15px] w-5 text-center">{n.icon}</span>
                    <span className="hidden md:inline">{n.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Data status banner */}
        {isDemo && (
          <div className="bg-[#451a03] border-b border-[#b45309] text-[#fcd34d] text-[12px] px-4 py-1.5 flex items-center gap-2 flex-wrap">
            <span className="tag tag-demo">DEMO / ILLUSTRATIVE</span>
            <span>当前联盟、球队与球员均为虚构演示数据，非真实联赛数据。可在「设置」导入真实授权数据。</span>
          </div>
        )}
        {isGod && (
          <div className="bg-[#450a0a] border-b border-[#dc2626] text-[#fca5a5] text-[12px] px-4 py-1.5 font-bold flex items-center gap-2">
            <span className="tag tag-god">GOD MODE</span>
            <span>上帝模式已启用 — 所有操作将绕过常规限制并写入审计日志，可在「操作日志」查看，最近操作可撤销。</span>
          </div>
        )}

        {/* Top bar */}
        <header className="border-b border-[var(--border)] bg-[var(--bg-panel)] px-4 py-2.5 flex items-center gap-4 flex-wrap">
          {save ? (
            <>
              <div className="font-semibold text-[14px]">
                {team ? `${team.city} ${team.name}` : save.name}
                <span className="text-[var(--text-dim)] text-[12px] font-normal ml-2">{team ? `(${team.abbr})` : ""}</span>
              </div>
              <div className="text-[12px] text-[var(--text-dim)]">
                赛季 {save.season - 1}-{String(save.season).slice(2)} · {PHASE_LABEL[save.phase] ?? save.phase} · {save.currentDate}
              </div>
              {team && (
                <div className="text-[12px]">
                  <span className="text-[var(--good)] font-semibold">{team.wins}</span>
                  <span className="text-[var(--text-dim)]">胜</span>
                  <span className="text-[var(--bad)] font-semibold ml-1.5">{team.losses}</span>
                  <span className="text-[var(--text-dim)]">负</span>
                </div>
              )}
              {summary?.cap && (
                <div className="text-[12px] text-[var(--text-dim)]">
                  薪资 <span className={summary.cap.overTax ? "text-[var(--bad)]" : "text-[var(--text)]"}>{summary.cap.totalSalary > 0 ? `${summary.cap.totalSalary.toFixed(1)}M` : "未知"}</span> / 帽 {summary.cap.cap}M
                </div>
              )}
              {summary?.chemistry && (
                <div className="text-[12px] text-[var(--text-dim)]">
                  阵容状态 <span className={chemColor(summary.chemistry.overall)}>{chemLabel(summary.chemistry.overall)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="text-[13px] text-[var(--text-dim)]">{saveId ? "加载存档中…" : "未选择存档"}</div>
          )}
        </header>

        <main className="flex-1 p-3 md:p-4 max-w-[1500px] w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}

function chemLabel(v: number) {
  if (v >= 75) return "磨合成熟";
  if (v >= 55) return "一般";
  return "存在隐患";
}

function chemColor(v: number) {
  if (v >= 75) return "text-[var(--good)] font-semibold";
  if (v >= 55) return "text-[var(--warn)] font-semibold";
  return "text-[var(--bad)] font-semibold";
}
