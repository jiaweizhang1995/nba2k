"use client";

// 比赛推进：主操作 = 推进到下一场比赛（你的球队打完为止）。
// 批量推进（天/周/月/赛季）收进次级菜单。推进后按决策价值排序展示：
// 比赛结果 → 伤病与疲劳变化 → 需要处理的事件 → 胜负原因；其余比赛折叠。

import { useState } from "react";
import Link from "next/link";
import { api, useSave, PHASE_LABEL } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface UserGameSummary {
  gameId: string;
  date: string;
  home: boolean;
  opponent: string;
  myScore: number;
  oppScore: number;
  win: boolean;
  ot: boolean;
  topPerformers: { name: string; team: string; pts: number; reb: number; ast: number; mp: number }[];
  keyReasons: string[];
}

interface AdvanceResult {
  days: number;
  gamesPlayed: number;
  results: { date: string; home: string; away: string; homeScore: number; awayScore: number }[];
  injuries: { playerId: string; name: string; description: string; weeks: number }[];
  phaseChanged: string | null;
  champion: string | null;
  notes: string[];
  awards: { type: string; player: string | null; team: string | null }[];
  userGames?: UserGameSummary[];
  fatigueChanges?: { name: string; from: number; to: number }[];
}

const BULK_MODES: { mode: string; label: string; hint: string }[] = [
  { mode: "DAY", label: "推进 1 天", hint: "模拟一天内的所有比赛" },
  { mode: "WEEK", label: "推进 1 周", hint: "模拟 7 天" },
  { mode: "MONTH", label: "推进 1 月", hint: "模拟 30 天" },
  { mode: "REGULAR_SEASON", label: "打完常规赛", hint: "推进至季后赛开始" },
  { mode: "PLAYOFFS", label: "打完季后赛", hint: "推进至总冠军产生" },
  { mode: "SEASON", label: "整个赛季", hint: "常规赛+季后赛，直至休赛期" },
];

export default function SimPage() {
  const { summary, saveId, refresh } = useSave();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<AdvanceResult | null>(null);
  const [showBulk, setShowBulk] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const advance = async (mode: string) => {
    setBusy(mode);
    try {
      const j = await api<{ result: AdvanceResult }>(`/api/saves/${saveId}/sim`, { method: "POST", body: JSON.stringify({ mode }) });
      setResult(j.result);
      const phaseNote = j.result.phaseChanged ? `，阶段 → ${PHASE_LABEL[j.result.phaseChanged] ?? j.result.phaseChanged}` : "";
      setToast({ msg: `推进 ${j.result.days} 天，${j.result.gamesPlayed} 场比赛${phaseNote}`, kind: "ok" });
      await refresh();
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(null);
    }
  };

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;

  const phase = summary.save.phase;
  const phaseLabel = PHASE_LABEL[phase] ?? phase;
  const userGames = result?.userGames ?? [];
  const needsAction = phase === "DRAFT" || phase === "FREE_AGENCY";

  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2 space-y-4">
          <Section title={`推进比赛（当前：${phaseLabel} · ${summary.save.currentDate}）`}>
            <div className="flex items-center gap-3 flex-wrap">
              <button className="btn btn-primary text-[14px] py-2.5 px-6" disabled={!!busy} onClick={() => advance("NEXT_GAME")}>
                {busy === "NEXT_GAME" ? "模拟中…" : "▶ 推进到下一场比赛"}
              </button>
              <button className="btn text-[12px]" onClick={() => setShowBulk((v) => !v)}>
                {showBulk ? "收起批量推进 ▲" : "批量推进 ▼"}
              </button>
            </div>
            {showBulk && (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-3 pt-3 border-t border-[#1a2440]">
                {BULK_MODES.map((m) => (
                  <button key={m.mode} className="btn flex-col !items-start py-2" disabled={!!busy} onClick={() => advance(m.mode)} title={m.hint}>
                    <span>{busy === m.mode ? "模拟中…" : m.label}</span>
                    <span className="text-[10px] font-normal opacity-80">{m.hint}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="text-[11px] text-[var(--text-dim)] mt-3 leading-relaxed">
              模拟为确定性引擎：相同存档 + 相同操作序列 = 完全相同结果。推进至选秀/自由市场后需在对应页面手动操作。
            </div>
          </Section>

          {result && (
            <>
              {/* 1. 比赛结果 */}
              {userGames.length > 0 && (
                <Section title="你的比赛">
                  <div className="space-y-3">
                    {userGames.map((g) => (
                      <div key={g.gameId} className={`panel-2 p-3 border-l-2 ${g.win ? "border-[var(--good)]" : "border-[var(--bad)]"}`}>
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className={`text-[14px] font-bold px-2 py-0.5 rounded ${g.win ? "bg-[#052e16] text-[#86efac]" : "bg-[#450a0a] text-[#fca5a5]"}`}>{g.win ? "胜" : "负"}</span>
                          <span className="text-[18px] font-bold tabular-nums">
                            {summary.userTeam?.abbr} {g.myScore} — {g.oppScore} {g.opponent}
                          </span>
                          {g.ot && <span className="tag">加时</span>}
                          <span className="text-[12px] text-[var(--text-dim)]">{g.date.slice(5)} {g.home ? "主场" : "客场"}</span>
                        </div>
                        <div className="grid sm:grid-cols-3 gap-2 mt-2.5">
                          {g.topPerformers.map((p, i) => (
                            <div key={i} className="text-[12px] panel-2 px-2.5 py-1.5">
                              <b>{p.name}</b> <span className="text-[var(--text-dim)]">({p.team})</span>
                              <br />
                              {p.pts} 分 {p.reb} 板 {p.ast} 助 · {p.mp} 分钟
                            </div>
                          ))}
                        </div>
                        {/* 4. 胜负原因 */}
                        {g.keyReasons.length > 0 && (
                          <div className="text-[12px] mt-2.5 leading-relaxed text-[var(--text-dim)]">
                            <div className="font-semibold text-[var(--text)] mb-0.5">为什么是这个结果</div>
                            {g.keyReasons.map((r, i) => (
                              <div key={i}>· {r}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}
              {!userGames.length && result.gamesPlayed > 0 && (
                <Section title={`已模拟 ${result.gamesPlayed} 场比赛`}>
                  <div className="text-[12px] text-[var(--text-dim)]">
                    本次推进未包含你球队的比赛（或为批量推进）。完整比分见下方「其他比赛」。
                  </div>
                </Section>
              )}
              {!result.gamesPlayed && <Section title="模拟报告"><div className="text-[12px] text-[var(--text-dim)]">没有比赛被模拟{result.days > 0 ? `（推进了 ${result.days} 天，期间无赛程）` : ""}。</div></Section>}

              {/* 2. 伤病与疲劳变化 */}
              {(result.injuries.length > 0 || (result.fatigueChanges?.length ?? 0) > 0) && (
                <Section title="伤病与疲劳变化" right={<Link href="/roster" className="text-[12px] text-[var(--accent)]">调整轮换 →</Link>}>
                  {result.injuries.length > 0 && (
                    <div className="space-y-1 mb-2">
                      {result.injuries.map((i, idx) => (
                        <div key={idx} className="text-[12px] text-[var(--bad)]">
                          🚑 <b>{i.name}</b> {i.description}，预计伤停约 {i.weeks * 7} 天
                        </div>
                      ))}
                    </div>
                  )}
                  {(result.fatigueChanges?.length ?? 0) > 0 && (
                    <div className="text-[12px] text-[var(--text-dim)] leading-relaxed">
                      体力下降：{result.fatigueChanges!.slice(0, 6).map((f) => `${f.name} ${f.from}%→${f.to}%`).join("、")}
                      {result.fatigueChanges!.length > 6 ? " 等" : ""}
                    </div>
                  )}
                </Section>
              )}

              {/* 3. 需要经理处理的事件 */}
              {(needsAction || result.phaseChanged || result.awards.length > 0 || result.champion) && (
                <Section title="需要处理的事件">
                  <div className="space-y-2 text-[13px]">
                    {result.champion && <div className="font-bold text-[var(--warn)]">🏆 总冠军产生：{result.champion}</div>}
                    {result.awards.map((a, i) => (
                      <div key={i} className="panel-2 px-3 py-2 text-[12px]">
                        {a.type === "CHAMPION" ? "总冠军" : a.type === "MVP" ? "MVP" : a.type === "DPOY" ? "最佳防守球员" : "最佳新秀"}：{a.player ?? a.team}
                      </div>
                    ))}
                    {result.phaseChanged && (
                      <div className="panel-2 px-3 py-2 text-[12px]">
                        阶段变更 → <b>{PHASE_LABEL[result.phaseChanged] ?? result.phaseChanged}</b>
                        {result.phaseChanged === "DRAFT" && (
                          <>
                            {" "}
                            <Link href="/draft" className="text-[var(--accent)]">去选秀 →</Link>
                          </>
                        )}
                        {result.phaseChanged === "FREE_AGENCY" && (
                          <>
                            {" "}
                            <Link href="/freeagency" className="text-[var(--accent)]">去自由市场 →</Link>
                          </>
                        )}
                      </div>
                    )}
                    {phase === "DRAFT" && !result.phaseChanged && (
                      <div className="panel-2 px-3 py-2 text-[12px]">
                        选秀大会进行中 <Link href="/draft" className="text-[var(--accent)]">去选秀 →</Link>
                      </div>
                    )}
                    {phase === "FREE_AGENCY" && !result.phaseChanged && (
                      <div className="panel-2 px-3 py-2 text-[12px]">
                        自由市场开放中 <Link href="/freeagency" className="text-[var(--accent)]">去自由市场 →</Link>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* 休赛期事项（成长/续约等） */}
              {result.notes.length > 0 && (
                <Section title="联盟动态">
                  <div className="text-[12px] text-[var(--text-dim)] leading-relaxed space-y-0.5">
                    {result.notes.slice(0, 10).map((n, i) => (
                      <div key={i}>· {n}</div>
                    ))}
                  </div>
                </Section>
              )}

              {/* 其他比赛（折叠，避免刷屏） */}
              {result.results.length > 0 && (
                <Section title="全部比分明细" right={<button className="text-[12px] text-[var(--accent)]" onClick={() => setShowOthers((v) => !v)}>{showOthers ? "收起" : `展开（${result.results.length} 场）`}</button>}>
                  {showOthers && (
                    <div className="scrollbox max-h-72">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>日期</th>
                            <th>客队</th>
                            <th>比分</th>
                            <th>主队</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.results.map((r, i) => (
                            <tr key={i}>
                              <td className="text-[var(--text-dim)]">{r.date.slice(5)}</td>
                              <td>{r.away}</td>
                              <td className="font-semibold tabular-nums">{r.awayScore} : {r.homeScore}</td>
                              <td>{r.home}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>
              )}
            </>
          )}
        </div>

        <Section title="阶段流转">
          <div className="text-[12px] space-y-2 leading-relaxed text-[var(--text-dim)]">
            <div>
              <b className="text-[var(--text)]">常规赛</b>：推进日期即模拟当日比赛；82 场打完后自动生成季后赛对阵（每联盟前 8）。
            </div>
            <div>
              <b className="text-[var(--text)]">季后赛</b>：四轮 7 战 4 胜（2-2-1-1-1 主场）；冠军产生后进入休赛期并结算奖项。
            </div>
            <div>
              <b className="text-[var(--text)]">休赛期 → 选秀</b>：球员成长/衰退、合同到期、乐透抽签自动完成；选秀需手动操作。
            </div>
            <div>
              <b className="text-[var(--text)]">选秀 → 自由市场</b>：落选新秀进入市场；球队自动补足最低阵容。
            </div>
            <div>
              <b className="text-[var(--text)]">自由市场 → 新赛季</b>：完成签约后点击「开始新赛季」生成新赛程。
            </div>
          </div>
        </Section>
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
