"use client";

// 模型对比页：同一场景（基准存档/球队/种子/年限）下的多模型并排对比

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface EvalRow {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  teamShortId: string;
  seed: number;
  years: number;
  status: string;
  score: { score?: number; totalWins?: number; playoffCount?: number; champCount?: number; legalRate?: number; errorRate?: number; callCount?: number; latencyMsSum?: number; finalChemistry?: number; replayMatch?: boolean } | null;
}

interface Comparison {
  scoreVersion: string;
  sameScenario: boolean;
  comparison: {
    id: string;
    name: string;
    provider: string;
    model: string | null;
    apiKeyMasked: string | null;
    totalWins: number;
    playoffCount: number;
    champCount: number;
    legalRate: number | null;
    errorRate: number | null;
    callCount: number;
    latencyMsSum: number;
    finalChemistry: number | null;
    score: number | null;
    replayMatch?: boolean;
  }[];
}

export default function EvalComparePage() {
  const [evals, setEvals] = useState<EvalRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<Comparison | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const load = useCallback(async () => {
    const j = await api<{ evaluations: EvalRow[] }>("/api/eval").catch(() => ({ evaluations: [] }));
    setEvals(j.evaluations);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 场景分组（基准存档+球队+种子+年限相同才可对比）
  const groups = useMemo(() => {
    const map = new Map<string, EvalRow[]>();
    for (const e of evals) {
      const key = `${e.teamShortId}|${e.seed}|${e.years}`;
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map.entries()].filter(([, rows]) => rows.length >= 2);
  }, [evals]);

  const toggle = (id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const compare = async () => {
    if (selected.length < 2) {
      setToast({ msg: "请至少选择两个评测", kind: "err" });
      return;
    }
    try {
      const j = await api<Comparison>(`/api/eval/compare?ids=${selected.join(",")}`);
      setResult(j);
      if (!j.sameScenario) setToast({ msg: "注意：所选评测的场景不完全一致（球队/种子/年限不同），对比仅供参考", kind: "err" });
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  return (
    <div className="space-y-4">
      <Section title="选择要对比的评测（建议同场景：同球队+同种子+同年限）">
        {evals.length === 0 && <div className="text-[13px] text-[var(--text-dim)] py-4">还没有评测。</div>}
        <div className="space-y-2">
          {evals.map((e) => {
            const inGroup = groups.some(([, rows]) => rows.some((r) => r.id === e.id));
            return (
              <label key={e.id} className={`panel-2 px-3 py-2.5 flex items-center gap-3 cursor-pointer ${inGroup ? "" : "opacity-50"}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(e.id)}
                  onChange={() => toggle(e.id)}
                  disabled={!inGroup}
                  title={inGroup ? "" : "没有同场景的评测可对比（需同球队+种子+年限）"}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold truncate">
                    {e.name} <span className="tag ml-1">{e.provider === "STUB" ? "STUB" : e.model ?? "?"}</span>
                    {e.score?.replayMatch === true && <span className="tag tag-imported ml-1">回放一致</span>}
                  </div>
                  <div className="text-[11px] text-[var(--text-dim)]">
                    {e.years} 年 · 种子 {e.seed} · {e.teamShortId} · {e.status}
                    {e.score?.score != null ? ` · GM-BENCH ${e.score.score}` : ""}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        <button className="btn btn-primary mt-3" onClick={compare} disabled={selected.length < 2}>
          对比（{selected.length}）
        </button>
      </Section>

      {result && (
        <Section title={`对比结果（${result.scoreVersion}${result.sameScenario ? " · 同场景" : " · 场景不一致，仅供参考"}）`}>
          <div className="scrollbox">
            <table className="data">
              <thead>
                <tr>
                  <th>评测</th>
                  <th>模型</th>
                  <th>总胜场</th>
                  <th>季后赛</th>
                  <th>冠军</th>
                  <th>合法率</th>
                  <th>错误率</th>
                  <th>调用</th>
                  <th>耗时</th>
                  <th>化学反应</th>
                  <th>GM-BENCH</th>
                </tr>
              </thead>
              <tbody>
                {result.comparison.map((c) => (
                  <tr key={c.id}>
                    <td className="font-medium">{c.name}</td>
                    <td>{c.provider === "STUB" ? "STUB" : c.model ?? "?"}</td>
                    <td className="font-semibold text-[var(--accent)]">{c.totalWins}</td>
                    <td>{c.playoffCount}</td>
                    <td>{c.champCount}</td>
                    <td>{c.legalRate != null ? `${Math.round(c.legalRate * 100)}%` : "—"}</td>
                    <td>{c.errorRate != null ? `${Math.round(c.errorRate * 100)}%` : "—"}</td>
                    <td>{c.callCount}</td>
                    <td>{(c.latencyMsSum / 1000).toFixed(1)}s</td>
                    <td>{c.finalChemistry ?? "—"}</td>
                    <td>
                      <b>{c.score ?? "—"}</b>
                      {c.replayMatch === true && <span className="tag tag-imported ml-1">回放✓</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[11px] text-[var(--text-dim)] mt-2">
            对比基于相同场景（基准存档快照+球队+种子+年限）下各模型的实际运营结果。获胜规则：GM-BENCH v1 得分越高越好。
          </div>
        </Section>
      )}

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
