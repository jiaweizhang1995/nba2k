"use client";

// Season simulation: advance day/week/month/season with day reports.

import { useState } from "react";
import { api, useSave, PHASE_LABEL } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface AdvanceResult {
  days: number;
  gamesPlayed: number;
  results: { date: string; home: string; away: string; homeScore: number; awayScore: number }[];
  injuries: { playerId: string; name: string; description: string; weeks: number }[];
  phaseChanged: string | null;
  champion: string | null;
  notes: string[];
  awards: { type: string; player: string | null; team: string | null }[];
}

const MODES: { mode: string; label: string; hint: string }[] = [
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

  return (
    <div className="grid lg:grid-cols-3 gap-4 items-start">
      <div className="lg:col-span-2 space-y-4">
        <Section title={`推进时间（当前：${PHASE_LABEL[summary.save.phase] ?? summary.save.phase} · ${summary.save.currentDate}）`}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {MODES.map((m) => (
              <button key={m.mode} className="btn btn-primary flex-col !items-start py-2.5" disabled={!!busy} onClick={() => advance(m.mode)} title={m.hint}>
                <span>{busy === m.mode ? "模拟中…" : m.label}</span>
                <span className="text-[10px] font-normal opacity-80">{m.hint}</span>
              </button>
            ))}
          </div>
          <div className="text-[11px] text-[var(--text-dim)] mt-3 leading-relaxed">
            模拟引擎为确定性引擎（GAME-SIM v1.0 / SEASON-SIM v1.0）：同一存档种子 + 相同操作序列 = 完全相同结果。推进至选秀/自由市场后需在对应页面手动操作。
          </div>
        </Section>

        {result && (
          <Section title={`模拟报告（${result.days} 天 / ${result.gamesPlayed} 场）`}>
            <div className="space-y-3">
              {result.champion && <div className="text-[14px] font-bold text-[var(--warn)]">🏆 总冠军产生：{result.champion}</div>}
              {result.awards.length > 0 && (
                <div className="panel-2 p-2.5 text-[12px]">
                  {result.awards.map((a, i) => (
                    <div key={i}>
                      {a.type === "CHAMPION" ? "总冠军" : a.type === "MVP" ? "MVP" : a.type === "DPOY" ? "最佳防守球员" : a.type === "ROY" ? "最佳新秀" : a.type}: {a.player ?? a.team}
                    </div>
                  ))}
                </div>
              )}
              {result.injuries.length > 0 && (
                <div className="text-[12px] text-[var(--bad)]">伤病：{result.injuries.map((i) => `${i.name}（${i.description}，${i.weeks} 周）`).join("、")}</div>
              )}
              {result.results.length > 0 && (
                <div className="scrollbox max-h-64">
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
                          <td className="font-semibold tabular-nums">
                            {r.awayScore} : {r.homeScore}
                          </td>
                          <td>{r.home}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {result.notes.length > 0 && (
                <div className="text-[12px] text-[var(--text-dim)] leading-relaxed">{result.notes.slice(0, 12).map((n, i) => <div key={i}>· {n}</div>)}</div>
              )}
            </div>
          </Section>
        )}
      </div>

      <Section title="阶段流转">
        <div className="text-[12px] space-y-2 leading-relaxed text-[var(--text-dim)]">
          <div>
            <b className="text-[var(--text)]">常规赛</b>：推进日期即模拟当日比赛；82 场打完后自动生成季后赛对阵（每联盟前 8）。
          </div>
          <div>
            <b className="text-[var(--text)]">季后赛</b>：四轮 7 战 4 胜；冠军产生后进入休赛期并结算奖项。
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

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
