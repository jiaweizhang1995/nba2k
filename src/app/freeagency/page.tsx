"use client";

// Free agency: market list, offer builder, AI competition, phase controls.

import { useCallback, useEffect, useState } from "react";
import { api, useSave } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";
import { CBA } from "@/domain/salary";

interface FaPlayer {
  id: string;
  name: string;
  position: string;
  age: number;
  overall: number;
  potential: number | null;
  askingSalary: number;
  askingYears: number;
  priorSalary: number | null;
}

export default function FreeAgencyPage() {
  const { summary, saveId, refresh } = useSave();
  const [fas, setFas] = useState<FaPlayer[]>([]);
  const [selected, setSelected] = useState<FaPlayer | null>(null);
  const [years, setYears] = useState(3);
  const [salary, setSalary] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ accepted: boolean; reason?: string; interest?: number; reasons?: string[] } | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const isGod = !!summary?.save.godMode;

  const load = useCallback(async () => {
    if (!saveId) return;
    const j = await api<{ freeAgents: FaPlayer[]; phase: string }>(`/api/saves/${saveId}/fa`);
    setFas(j.freeAgents);
  }, [saveId]);

  useEffect(() => {
    void load();
  }, [load]);

  const offer = async () => {
    if (!selected) return;
    setBusy(true);
    setResult(null);
    try {
      const j = await api<{ result: { accepted: boolean; reason?: string; interest?: number; reasons?: string[] } }>(`/api/saves/${saveId}/fa`, {
        method: "POST",
        body: JSON.stringify({ playerId: selected.id, years, avgSalary: salary }),
      });
      setResult(j.result);
      if (j.result.accepted) {
        setToast({ msg: `签约成功：${selected.name}`, kind: "ok" });
        setSelected(null);
        await Promise.all([load(), refresh()]);
      }
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  const phaseAction = async (action: string, label: string) => {
    setBusy(true);
    try {
      await api(`/api/saves/${saveId}/fa?action=${action}`, { method: "POST", body: JSON.stringify({ playerId: "x", years: 1, avgSalary: 1 }) });
      setToast({ msg: label, kind: "ok" });
      await refresh();
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;
  const phase = summary.save.phase;
  const capSpace = summary.cap.capSpace;

  return (
    <div className="grid lg:grid-cols-3 gap-4 items-start">
      <div className="lg:col-span-2">
        <Section
          title={`自由球员市场（${fas.length} 人）`}
          right={
            phase === "DRAFT" ? (
              <button className="btn btn-primary" disabled={busy} onClick={() => phaseAction("startFreeAgency", "自由市场已开启")}>
                选秀已结束，开启自由市场
              </button>
            ) : phase === "FREE_AGENCY" ? (
              <button className="btn btn-primary" disabled={busy} onClick={() => phaseAction("startNewSeason", "新赛季已开始")}>
                结束市场，开始新赛季
              </button>
            ) : (
              <span className="tag">当前阶段：{phase}</span>
            )
          }
        >
          <div className="scrollbox max-h-[480px]">
            <table className="data">
              <thead>
                <tr>
                  <th>球员</th>
                  <th>位置</th>
                  <th>年龄</th>
                  <th>综合</th>
                  <th>要价</th>
                  <th>合同年限</th>
                  <th>上份薪资</th>
                </tr>
              </thead>
              <tbody>
                {fas.map((p) => (
                  <tr key={p.id} onClick={() => { setSelected(p); setYears(p.askingYears); setSalary(Math.max(CBA.minimumSalary, Math.min(p.askingSalary, Math.max(CBA.minimumSalary, capSpace > 0 ? p.askingSalary : 12.8)))); }} style={{ cursor: "pointer", background: selected?.id === p.id ? "#1d2b4a" : undefined }}>
                    <td className="font-medium">{p.name}</td>
                    <td>{p.position}</td>
                    <td>{p.age}</td>
                    <td className="text-[var(--accent)] font-semibold">{p.overall}</td>
                    <td>{p.askingSalary.toFixed(1)}M/年</td>
                    <td>{p.askingYears} 年</td>
                    <td className="text-[var(--text-dim)]">{p.priorSalary != null ? `${p.priorSalary.toFixed(1)}M` : "未知"}</td>
                  </tr>
                ))}
                {fas.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center text-[var(--text-dim)] py-6">
                      市场上暂无自由球员
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <div className="space-y-4">
        <Section title="报价">
          {phase !== "FREE_AGENCY" && phase !== "OFFSEASON" ? (
            <div className="text-[12px] text-[var(--text-dim)]">当前不在自由市场阶段。完成赛季推进进入休赛期后可签约。</div>
          ) : !selected ? (
            <div className="text-[12px] text-[var(--text-dim)]">在左侧列表选择一名自由球员。</div>
          ) : (
            <div className="space-y-3">
              <div className="text-[13px] font-semibold">
                {selected.name}
                <span className="text-[var(--text-dim)] font-normal text-[12px] ml-2">
                  {selected.position} · {selected.age}岁 · 综合 {selected.overall}
                </span>
              </div>
              <div className="text-[12px] text-[var(--text-dim)]">要价 {selected.askingSalary.toFixed(1)}M × {selected.askingYears} 年</div>
              <div>
                <label className="text-[12px] text-[var(--text-dim)] block mb-1">年薪（M）</label>
                <input className="input" type="number" step="0.5" min="1.2" max="70" value={salary} onChange={(e) => setSalary(Number(e.target.value))} />
              </div>
              <div>
                <label className="text-[12px] text-[var(--text-dim)] block mb-1">年限</label>
                <input className="input" type="number" min="1" max="5" value={years} onChange={(e) => setYears(Number(e.target.value))} />
              </div>
              <div className="text-[11px] text-[var(--text-dim)] leading-relaxed panel-2 p-2">
                当前薪资空间 {capSpace > 0 ? `${capSpace.toFixed(1)}M` : "无（超帽）"}。超帽时可使用中产/底薪特例；超过第二土豪线（{CBA.secondApron}M）只能签底薪。
                球员是否接受由其兴趣度计算：金额、球队实力、位置契合与竞争报价均有影响。
              </div>
              <button className="btn btn-primary w-full" onClick={offer} disabled={busy}>
                {busy ? "谈判中…" : "提交报价"}
              </button>
              {result && !result.accepted && (
                <div className="panel-2 p-2.5 text-[12px] text-[var(--bad)] leading-relaxed">
                  报价被拒{result.interest != null ? `（兴趣度 ${result.interest}/100，需 ≥ 62）` : ""}
                  {result.reason ? <div className="text-[var(--text-dim)] mt-1">{result.reason}</div> : null}
                </div>
              )}
            </div>
          )}
        </Section>

        {isGod && (
          <Section title="GOD MODE">
            <button className="btn btn-god w-full" disabled={busy} onClick={() => phaseAction("startFreeAgency", "GOD：强制开启自由市场")}>
              强制进入自由市场
            </button>
          </Section>
        )}
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
