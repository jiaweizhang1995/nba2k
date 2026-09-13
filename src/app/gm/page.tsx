"use client";

// GM 决策中枢：战绩/排名/走势、下一场与赛程、伤病疲劳、轮换、薪资税负、
// 问题与建议动作、待处理事件、最近比赛与原因。每块信息都可跳转到对应操作。
// 技术信息（种子/引擎版本/数据源）不在此页 —— 见「设置」。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, useSave, PHASE_LABEL } from "@/components/save-context";
import { Section } from "@/components/ui";

interface Dashboard {
  team: { id: string; abbr: string; city: string; name: string; conference: string; wins: number; losses: number; phase: string; currentDate: string; season: number };
  standings: { rank: number; total: number; leaderAbbr: string; gamesBack: number };
  trend: { last10: string; streak: string | null };
  nextGame: { date: string; home: boolean; opponent: string; opponentName: string; opponentRecord: string; backToBack: boolean } | null;
  upcoming: { date: string; home: boolean; opponent: string; opponentName: string; opponentRecord: string }[];
  recentGames: { gameId: string; date: string; home: boolean; opponent: string; myScore: number; oppScore: number; win: boolean; topPerf: string | null; keyReasons: string[] }[];
  injuries: { playerId: string; name: string; position: string; overall: number; description: string; weeks: number; severity: string; isStarter: boolean }[];
  fatigue: { playerId: string; name: string; stamina: number; isStarter: boolean }[];
  rotation: { configured: boolean; starters: { id: string; name: string; position: string; overall: number; minutes: number | null; stamina: number; injured: boolean }[]; benchTop: { id: string; name: string; position: string; overall: number; minutes: number | null; stamina: number; injured: boolean }[] };
  cap: { totalSalary: number; capSpace: number; overCap: boolean; overTax: boolean; taxBill: number; cap: number; luxuryTax: number };
  chemistry: { overall: number; conclusions: { label: string; score: number; note: string }[] };
  advisors: { id: string; severity: "HIGH" | "MEDIUM" | "LOW"; title: string; detail: string; actionLabel: string; actionHref: string }[];
  pendingEvents: { title: string; actionLabel: string; actionHref: string }[];
}

export default function GmHome() {
  const { summary, saveId, refresh } = useSave();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNews, setAiNews] = useState<string | null>(null);
  const [showAi, setShowAi] = useState(false);

  const load = useCallback(async () => {
    if (!saveId) return;
    try {
      const j = await api<Dashboard>(`/api/saves/${saveId}/dashboard`);
      setDash(j);
    } catch {
      // 未选球队等场景：保留 null，页面提示
      setDash(null);
    }
    await refresh();
  }, [saveId, refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const makeNews = async () => {
    if (!saveId || !dash) return;
    setAiBusy(true);
    try {
      const facts = [
        `${dash.team.city} ${dash.team.name} 目前 ${dash.team.wins} 胜 ${dash.team.losses} 负（${dash.team.conference === "WEST" ? "西部" : "东部"}第 ${dash.standings.rank}）`,
        `近 10 场 ${dash.trend.last10}${dash.trend.streak ? `，${dash.trend.streak}` : ""}`,
        `总薪资 ${dash.cap.totalSalary.toFixed(1)}M（帽 ${dash.cap.cap}M，税线 ${dash.cap.luxuryTax}M）`,
        ...dash.advisors.slice(0, 3).map((a) => a.title),
      ];
      const j = await api<{ ok: boolean; text: string }>("/api/ai/news", {
        method: "POST",
        body: JSON.stringify({ saveId, headline: `${dash.team.city} 更衣室周报`, facts, tone: "ANALYSIS" }),
      });
      setAiNews(j.text);
    } catch (e) {
      setAiNews(`AI 请求失败：${(e as Error).message}`);
    } finally {
      setAiBusy(false);
    }
  };

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…（若长时间无响应，请回到首页选择存档）</div>;
  if (!dash) {
    return (
      <div className="text-[13px] text-[var(--text-dim)] p-4 space-y-2">
        <div>暂无决策面板数据。</div>
        {summary.save.phase === "DRAFT" && <Link href="/draft" className="btn btn-primary inline-block">选秀大会进行中 →</Link>}
        {summary.save.phase === "FREE_AGENCY" && <Link href="/freeagency" className="btn btn-primary inline-block">自由市场开放中 →</Link>}
      </div>
    );
  }

  const confName = dash.team.conference === "WEST" ? "西部" : "东部";
  const taxTone = dash.cap.overTax ? "text-[var(--bad)]" : dash.cap.overCap ? "text-[var(--warn)]" : "text-[var(--good)]";

  return (
    <div className="space-y-4">
      {/* 顶部状态行：战绩 / 排名 / 走势 / 薪资 / 税 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat
          label="战绩"
          value={`${dash.team.wins}-${dash.team.losses}`}
          sub={`${confName}第 ${dash.standings.rank} / ${dash.standings.total}（落后榜首 ${dash.standings.gamesBack} 场）`}
          href="/league"
        />
        <Stat label="近 10 场" value={dash.trend.last10} sub={dash.trend.streak ?? "走势平稳"} />
        <Stat
          label="下一场"
          value={dash.nextGame ? `${dash.nextGame.home ? "vs" : "@"} ${dash.nextGame.opponent}` : "无排期"}
          sub={dash.nextGame ? `${dash.nextGame.date.slice(5)} · 对手 ${dash.nextGame.opponentRecord}${dash.nextGame.backToBack ? " · ⚠背靠背" : ""}` : PHASE_LABEL[dash.team.phase] ?? dash.team.phase}
        />
        <Stat label="薪资 / 帽" value={`${dash.cap.totalSalary > 0 ? dash.cap.totalSalary.toFixed(1) + "M" : "未知"}`} sub={`空间 ${dash.cap.capSpace > 0 ? "+" : ""}${dash.cap.capSpace.toFixed(1)}M`} href="/assets" />
        <Stat label="奢侈税风险" value={dash.cap.overTax ? `超税 ${dash.cap.taxBill.toFixed(1)}M` : "未触发"} sub={`税线 ${dash.cap.luxuryTax}M`} valueClass={taxTone} href="/trade" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2 space-y-4">
          {/* 待处理事件 + 建议 */}
          {(dash.pendingEvents.length > 0 || dash.advisors.length > 0) && (
            <Section title="需要你处理的事情" right={<span className="text-[11px] text-[var(--text-dim)]">按紧急度排序</span>}>
              <div className="space-y-2">
                {dash.pendingEvents.map((e, i) => (
                  <div key={`pe-${i}`} className="panel-2 px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap border-l-2 border-[var(--bad)]">
                    <div className="text-[13px] font-semibold">⏳ {e.title}</div>
                    <Link href={e.actionHref} className="btn btn-primary text-[12px] py-1">{e.actionLabel}</Link>
                  </div>
                ))}
                {dash.advisors.map((a) => (
                  <div key={a.id} className={`panel-2 px-3 py-2.5 border-l-2 ${a.severity === "HIGH" ? "border-[var(--bad)]" : "border-[var(--warn)]"}`}>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">{a.severity === "HIGH" ? "🔴" : "🟡"} {a.title}</div>
                        <div className="text-[12px] text-[var(--text-dim)] mt-0.5 leading-relaxed">{a.detail}</div>
                      </div>
                      <Link href={a.actionHref} className="btn text-[12px] py-1 shrink-0">{a.actionLabel} →</Link>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 最近比赛结果与关键原因 */}
          <Section title="最近比赛 — 结果与原因" right={<Link href="/sim" className="text-[12px] text-[var(--accent)]">前往比赛推进 →</Link>}>
            {dash.recentGames.length === 0 ? (
              <div className="text-[12px] text-[var(--text-dim)]">赛季尚未开始或暂无已完成的比赛。</div>
            ) : (
              <div className="space-y-2">
                {dash.recentGames.map((g) => (
                  <div key={g.gameId} className="panel-2 px-3 py-2.5">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className={`text-[12px] font-bold px-1.5 py-0.5 rounded ${g.win ? "bg-[#052e16] text-[#86efac]" : "bg-[#450a0a] text-[#fca5a5]"}`}>{g.win ? "胜" : "负"}</span>
                      <span className="text-[13px] font-semibold tabular-nums">
                        {g.myScore} : {g.oppScore}
                      </span>
                      <span className="text-[12px] text-[var(--text-dim)]">
                        {g.date.slice(5)} {g.home ? "vs" : "@"} {g.opponent}
                      </span>
                      {g.topPerf && <span className="text-[12px] text-[var(--text-dim)]">· 全场最佳 {g.topPerf}</span>}
                    </div>
                    {g.keyReasons.length > 0 && (
                      <div className="text-[12px] text-[var(--text-dim)] mt-1 leading-relaxed">
                        {g.keyReasons.map((r, i) => (
                          <div key={i}>· {r}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 未来赛程 */}
          <Section title="未来赛程">
            <div className="space-y-1">
              {dash.upcoming.length === 0 && <div className="text-[12px] text-[var(--text-dim)]">暂无排期（可能已进入休赛期）。</div>}
              {dash.upcoming.map((g, i) => (
                <div key={i} className="flex items-center justify-between text-[12px] py-1.5 border-b border-[#1a2440] gap-2">
                  <span className="text-[var(--text-dim)] tabular-nums">{g.date.slice(5)}</span>
                  <span className="font-medium">{g.home ? "vs" : "@"} {g.opponentName}</span>
                  <span className="text-[var(--text-dim)]">对手 {g.opponentRecord}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <div className="space-y-4">
          {/* 伤病与疲劳 */}
          <Section title="伤病与疲劳" right={<Link href="/roster" className="text-[12px] text-[var(--accent)]">调整轮换 →</Link>}>
            {dash.injuries.length === 0 && dash.fatigue.length === 0 && <div className="text-[12px] text-[var(--good)]">全员健康，体力充沛。</div>}
            {dash.injuries.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {dash.injuries.map((inj) => (
                  <div key={inj.playerId} className="flex items-center justify-between gap-2 text-[12px]">
                    <span>
                      {inj.isStarter && <span className="tag tag-god mr-1.5 !text-[10px]">首发</span>}
                      <b>{inj.name}</b> <span className="text-[var(--text-dim)]">{inj.position} · {inj.overall}</span>
                    </span>
                    <span className="text-[var(--bad)] text-right">
                      {inj.description} · 约 {inj.weeks} 天
                    </span>
                  </div>
                ))}
              </div>
            )}
            {dash.fatigue.length > 0 && (
              <div className="space-y-1.5 border-t border-[#1a2440] pt-2">
                <div className="text-[11px] text-[var(--text-dim)]">体力偏低（&lt;75%，上场时间与效率受影响）</div>
                {dash.fatigue.map((f) => (
                  <div key={f.playerId} className="flex items-center justify-between gap-2 text-[12px]">
                    <span>
                      {f.isStarter && <span className="tag tag-god mr-1.5 !text-[10px]">首发</span>}
                      {f.name}
                    </span>
                    <span className={f.stamina < 60 ? "text-[var(--bad)] font-semibold" : "text-[var(--warn)]"}>体力 {f.stamina}%</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 当前首发与轮换 */}
          <Section title="当前首发与轮换" right={<Link href="/roster" className="text-[12px] text-[var(--accent)]">{dash.rotation.configured ? "编辑" : "去设置"} →</Link>}>
            {!dash.rotation.configured && <div className="text-[11px] text-[var(--warn)] mb-2">尚未手动配置轮换，引擎按角色自动分配时间。到「阵容」页设置首发与分钟数。</div>}
            <div className="space-y-1">
              {dash.rotation.starters.map((p, i) => (
                <div key={p.id} className="flex items-center justify-between text-[12px] py-1 border-b border-[#1a2440] gap-2">
                  <span className="font-medium">
                    <span className="text-[var(--accent)] font-bold w-7 inline-block">{["PG", "SG", "SF", "PF", "C"][i]}</span>
                    {p.name} <span className="text-[var(--text-dim)]">{p.position}</span>
                    {p.injured && <span className="text-[var(--bad)] ml-1">伤停</span>}
                    {p.stamina < 70 && <span className="text-[var(--warn)] ml-1">体力 {p.stamina}%</span>}
                  </span>
                  <span className="tabular-nums">
                    <b className="text-[var(--accent)]">{p.overall}</b>
                    {p.minutes != null && <span className="text-[var(--text-dim)] text-[11px] ml-1.5">{p.minutes} 分</span>}
                  </span>
                </div>
              ))}
              <div className="text-[11px] text-[var(--text-dim)] pt-1.5">主要替补：{dash.rotation.benchTop.map((p) => p.name).join("、") || "无"}</div>
            </div>
          </Section>

          {/* 化学反应 → 篮球结论 */}
          <Section title="阵容诊断" right={<Link href="/chemistry" className="text-[12px] text-[var(--accent)]">详情 →</Link>}>
            <div className="space-y-1.5">
              {dash.chemistry.conclusions.map((c, i) => (
                <div key={i} className="text-[12px] leading-relaxed">
                  <span className={c.score < 55 ? "text-[var(--bad)] font-semibold" : c.score < 70 ? "text-[var(--warn)]" : "text-[var(--good)]"}>[{c.label}]</span>{" "}
                  {c.note}
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {/* AI 简报：辅助内容，折叠在底部 */}
      <Section
        title="AI 简报（辅助参考）"
        right={
          <div className="flex gap-2">
            <button className="btn text-[12px] py-1" onClick={() => setShowAi((v) => !v)}>
              {showAi ? "收起" : "展开"}
            </button>
            <button className="btn text-[12px] py-1" onClick={makeNews} disabled={aiBusy}>
              {aiBusy ? "生成中…" : aiNews ? "重新生成" : "生成"}
            </button>
          </div>
        }
      >
        {showAi ? (
          aiNews ? (
            <div className="text-[12px] leading-relaxed whitespace-pre-wrap">{aiNews}</div>
          ) : (
            <div className="text-[12px] text-[var(--text-dim)] leading-relaxed">
              可选功能：让 GLM 基于引擎计算的数据撰写周报，需要配置 AI 服务（见「设置」）。未配置时游戏核心功能不受影响；上面的「阵容诊断」为纯规则计算，无需 AI。
            </div>
          )
        ) : (
          <div className="text-[12px] text-[var(--text-dim)]">AI 周报为可选辅助内容，不参与引擎决策。点击「展开」查看。</div>
        )}
      </Section>

    </div>
  );
}

function Stat({ label, value, sub, valueClass, href }: { label: string; value: string; sub?: string; valueClass?: string; href?: string }) {
  const body = (
    <div className="panel p-3 h-full">
      <div className="text-[11px] text-[var(--text-dim)]">{label}</div>
      <div className={`text-[19px] font-bold tabular-nums mt-0.5 ${valueClass ?? ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-dim)] mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}
