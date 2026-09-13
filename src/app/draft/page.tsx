"use client";

// Draft page: board with scouting reports + lottery order + pick flow.

import { useCallback, useEffect, useState } from "react";
import { api, useSave } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface Prospect {
  id: string;
  name: string;
  position: string;
  age: number;
  heightCm: number;
  weightKg: number;
  ratings: { overall: number; potential: number | null; potentialLow: number | null; potentialHigh: number | null; confidence: number };
  scouting: { strengths: string[]; weaknesses: string[]; comparison: string; floor: number; ceiling: number; note: string };
}
interface OrderSlot {
  pickNumber: number;
  round: number;
  holderTeamId: string;
}
interface TeamRow {
  id: string;
  abbr: string;
  city: string;
  name: string;
}

export default function DraftPage() {
  const { summary, saveId, refresh } = useSave();
  const [board, setBoard] = useState<Prospect[]>([]);
  const [order, setOrder] = useState<OrderSlot[]>([]);
  const [teams, setTeams] = useState<Map<string, TeamRow>>(new Map());
  const [selected, setSelected] = useState<Prospect | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const load = useCallback(async () => {
    if (!saveId) return;
    const [d, t] = await Promise.all([
      api<{ board: Prospect[]; order: OrderSlot[]; draftYear: number; phase: string; rulesVersion: string }>(`/api/saves/${saveId}/draft`),
      api<{ teams: TeamRow[] }>(`/api/saves/${saveId}/teams`),
    ]);
    setBoard(d.board);
    setOrder(d.order);
    setTeams(new Map(t.teams.map((x) => [x.id, x])));
  }, [saveId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = async (prospectId?: string, simulateAll?: boolean) => {
    setBusy(true);
    try {
      await api(`/api/saves/${saveId}/draft`, { method: "POST", body: JSON.stringify({ prospectId, simulateAll }) });
      setToast({ msg: simulateAll ? "选秀完成" : "选择完成", kind: "ok" });
      setSelected(null);
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;

  const doneCount = 60 - board.length > 0 ? 60 - board.length : 0;
  const nextSlot = order[doneCount];
  const userTeamId = summary.userTeam?.id ?? "";
  const isUserPick = nextSlot && nextSlot.holderTeamId === userTeamId;
  const teamName = (id: string) => {
    const t = teams.get(id);
    return t ? t.abbr : id.slice(-3);
  };

  return (
    <div className="grid lg:grid-cols-3 gap-4 items-start">
      <div className="lg:col-span-2 space-y-4">
        <Section
          title={`新秀榜单（${summary.save.season} 届 · 剩余 ${board.length} 人）`}
          right={
            summary.save.phase === "DRAFT" ? (
              <div className="flex gap-2">
                {isUserPick && <span className="tag" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>轮到你的签</span>}
                <button className="btn btn-primary" disabled={busy || !isUserPick || !selected} onClick={() => selected && pick(selected.id)}>
                  选择 {selected?.name ?? "（先在榜单选择新秀）"}
                </button>
                <button className="btn" disabled={busy} onClick={() => pick(undefined, true)}>
                  模拟剩余选秀
                </button>
              </div>
            ) : (
              <span className="tag">当前不在选秀阶段（{summary.save.phase}）</span>
            )
          }
        >
          <div className="scrollbox max-h-[520px]">
            <table className="data">
              <thead>
                <tr>
                  <th>新秀</th>
                  <th>位置</th>
                  <th>年龄</th>
                  <th>即时评分</th>
                  <th>潜力区间</th>
                  <th>球探标签</th>
                </tr>
              </thead>
              <tbody>
                {board.map((p) => (
                  <tr key={p.id} onClick={() => setSelected(p)} style={{ cursor: "pointer", background: selected?.id === p.id ? "#1d2b4a" : undefined }}>
                    <td className="font-medium">{p.name}</td>
                    <td>{p.position}</td>
                    <td>{p.age}</td>
                    <td className="text-[var(--accent)] font-semibold">{p.ratings.overall}</td>
                    <td>{p.ratings.potential != null ? `${p.ratings.potentialLow}–${p.ratings.potentialHigh}` : "未知"}</td>
                    <td className="text-[var(--text-dim)]">{p.scouting.strengths[0] ?? "-"}</td>
                  </tr>
                ))}
                {board.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-[var(--text-dim)] py-6">
                      {doneCount > 0
                        ? "本届新秀已全部选择完毕"
                        : "本届暂无新秀数据（真实存档不虚构新秀名单；可在「设置 → 数据导入」上传新秀 CSV）。选秀阶段仍可直接「模拟剩余选秀」完成流转。"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <div className="space-y-4">
        {selected && (
          <Section title={`球探报告：${selected.name}`}>
            <div className="text-[12px] space-y-1.5">
              <div>
                {selected.position} · {selected.age} 岁 · {selected.heightCm}cm / {selected.weightKg}kg
              </div>
              <div>
                即时评分 <b className="text-[var(--accent)]">{selected.ratings.overall}</b>（置信度 {(selected.ratings.confidence * 100).toFixed(0)}%，无或少量职业样本）
              </div>
              <div>
                潜力区间：<b>{selected.ratings.potential != null ? `${selected.ratings.potentialLow} – ${selected.ratings.potentialHigh}` : "未知"}</b>（估计值，非确定）
              </div>
              <div className="panel-2 p-2.5 leading-relaxed">
                <div className="text-[var(--good)]">优势：{selected.scouting.strengths.join("、") || "—"}</div>
                <div className="text-[var(--bad)] mt-1">短板：{selected.scouting.weaknesses.join("、") || "—"}</div>
                <div className="text-[var(--text-dim)] mt-1">模板：{selected.scouting.comparison}</div>
              </div>
              <div className="text-[11px] text-[var(--text-dim)]">{selected.scouting.note}</div>
            </div>
          </Section>
        )}

        <Section title="选秀顺位（乐透已抽签）">
          <div className="scrollbox max-h-96">
            <table className="data">
              <thead>
                <tr>
                  <th>轮</th>
                  <th>顺位</th>
                  <th>球队</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {order.map((s, i) => (
                  <tr key={i} style={{ background: i === doneCount ? "#1d2b4a" : undefined }}>
                    <td>{s.round}</td>
                    <td>{s.pickNumber}</td>
                    <td>{teamName(s.holderTeamId)}</td>
                    <td>{i < doneCount ? "已选" : i === doneCount ? "当前" : "待选"}</td>
                  </tr>
                ))}
                {order.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center text-[var(--text-dim)] py-4">
                      尚未生成顺位（完成一个赛季后进入选秀）
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="text-[11px] text-[var(--text-dim)] mt-2">规则：{`LEAGUE CBA v1.0 / DRAFT-RULES v1.0`} · 前 14 顺位乐透加权，首轮新秀按顺位拿新秀合同（含球队选项）。</div>
        </Section>
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
