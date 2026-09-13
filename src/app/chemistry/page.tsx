"use client";

// Chemistry page: engine factors + GLM explanation.

import { useCallback, useEffect, useState } from "react";
import { api, useSave } from "@/components/save-context";
import { Section, RatingBar, Toast } from "@/components/ui";

interface ChemResp {
  aiOk: boolean;
  text: string;
  chemistry: {
    overall: number;
    factors: { key: string; label: string; score: number; note: string }[];
  };
}

export default function ChemistryPage() {
  const { summary, saveId } = useSave();
  const [data, setData] = useState<ChemResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const userTeamId = summary?.userTeam?.id;
  const load = useCallback(async () => {
    if (!saveId || !userTeamId) return;
    setBusy(true);
    try {
      const j = await api<ChemResp>("/api/ai/chemistry", {
        method: "POST",
        body: JSON.stringify({ saveId, teamId: userTeamId }),
      });
      setData(j);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(false);
    }
  }, [saveId, userTeamId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;
  const chem = data?.chemistry;
  const overall = chem?.overall ?? 0;

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      <Section title={`化学反应（${summary.userTeam?.city} ${summary.userTeam?.name}）`}>
        {chem ? (
          <>
            <div className="flex items-center gap-4 mb-4">
              <div className="text-[44px] font-bold tabular-nums" style={{ color: overall >= 75 ? "var(--good)" : overall >= 55 ? "var(--warn)" : "var(--bad)" }}>
                {overall}
              </div>
              <div className="text-[12px] text-[var(--text-dim)] leading-relaxed">
                由 CHEMISTRY v1.0 根据阵容结构、角色定位、球权需求、满意度与连续性计算。交易会实时改变这些因子。
              </div>
            </div>
            <div className="space-y-2.5">
              {chem.factors.map((f) => (
                <div key={f.key}>
                  <RatingBar label={f.label} value={f.score} />
                  <div className="text-[11px] text-[var(--text-dim)] mt-1 ml-16">{f.note}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="text-[13px] text-[var(--text-dim)]">{busy ? "计算中…" : "暂无数据"}</div>
        )}
      </Section>

      <Section title="AI 简报（GLM 基于以上因子生成）">
        {data?.aiOk ? (
          <div className="text-[13px] leading-relaxed whitespace-pre-wrap">{data.text}</div>
        ) : (
          <div className="text-[12px] text-[var(--text-dim)] leading-relaxed">
            {data && !data.aiOk ? data.text : "AI 功能未配置或未生成。配置 CommandCode 环境变量后可用（见设置页）；未配置不影响本页因子计算。"}
          </div>
        )}
        <button className="btn mt-3" onClick={load} disabled={busy}>
          {busy ? "生成中…" : "重新生成简报"}
        </button>
      </Section>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
