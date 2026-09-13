"use client";

// Roster page: sortable table + player detail with explainable ratings,
// raw stats, contract and full data provenance. God Mode quick-edit panel.

import { useCallback, useEffect, useState } from "react";
import { api, useSave, ROLE_LABEL } from "@/components/save-context";
import { Section, DataTable, RatingBar, ProvenanceTag, Toast, fmtSalary, fmtAvg } from "@/components/ui";

interface Player {
  id: string;
  name: string;
  teamId: string | null;
  teamAbbr: string | null;
  position: string;
  age: number;
  heightCm: number;
  weightKg: number;
  yearsPro: number;
  ratings: {
    overall: number;
    inside: number;
    finishing: number;
    threePoint: number;
    freeThrow: number;
    playmaking: number;
    rebounding: number;
    perimeterD: number;
    interiorD: number;
    potential: number | null;
    potentialLow: number | null;
    potentialHigh: number | null;
    confidence: number;
    ratingVersion: string;
  };
  seasonStats: { g: number; mp: number; pts: number; reb: number; ast: number; stl: number; blk: number; tov: number; fgm: number; fga: number; tpm: number; tpa: number; ftm: number; fta: number }[];
  baselineStats: { season: number; teamRow: string; g: number; mpg: number; fgPct: number | null; tpPct: number | null; ftPct: number | null; rpg: number; apg: number; spg: number; bpg: number; ppg: number } | null;
  careerStats: { season: number; g: number; pts: number; reb: number; ast: number }[];
  contract: { type: string; years: { season: number; salary: number }[]; noTrade: boolean; option: string | null };
  status: string;
  role: string;
  satisfaction: number;
  injury: { description: string; weeksRemaining: number } | null;
  development: { trajectory: string; growthLeft: number; lastDelta: number };
  source: { provider: string; sourceUrl: string | null; retrievedAt: string | null; season: number | null; licenseNote: string; status: string; ratingVersion: string } | null;
}

interface TeamRow {
  id: string;
  abbr: string;
  city: string;
  name: string;
}

export default function RosterPage() {
  const { summary, saveId } = useSave();
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [teamId, setTeamId] = useState<string>("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Player | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const isGod = !!summary?.save.godMode;

  useEffect(() => {
    if (!saveId) return;
    api<{ teams: TeamRow[] }>(`/api/saves/${saveId}/teams`).then((j) => {
      setTeams(j.teams);
      if (!teamId && summary?.userTeam) setTeamId(summary.userTeam.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, summary?.userTeam?.id]);

  const load = useCallback(async () => {
    if (!saveId || !teamId) return;
    const j = await api<{ players: Player[] }>(`/api/saves/${saveId}/roster?teamId=${encodeURIComponent(`${saveId}:${teamId}`)}`);
    setPlayers(j.players);
  }, [saveId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const godEdit = async (op: string, params: Record<string, unknown>) => {
    try {
      await api(`/api/saves/${saveId}/god`, { method: "POST", body: JSON.stringify({ op, params }) });
      setToast({ msg: "GOD 操作完成（已写入审计日志）", kind: "ok" });
      await load();
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  const statLine = (p: Player) => p.seasonStats[0];
  const perG = (v: number | undefined, g: number | undefined) => (g && g > 0 ? (v ?? 0) / g : 0);

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <select className="input max-w-56" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.city} {t.name}
            </option>
          ))}
        </select>
        {isGod && <span className="tag tag-god">GOD MODE：点击球员行可修改属性</span>}
      </div>

      <Section title={`阵容（${players.length} 人）`}>
        <DataTable
          rows={players as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.id)}
          onRowClick={(r) => setSelected(r as unknown as Player)}
          filterKeys={["name", "position", "role"] as never}
          initialSort={{ key: "ovr", dir: "desc" }}
          columns={[
            { key: "name", label: "球员", render: (r) => <span className="font-medium">{String(r.name)}</span> },
            { key: "pos", label: "位置", render: (r) => String(r.position) },
            { key: "age", label: "年龄", render: (r) => String(r.age) },
            { key: "ovr", label: "综合", render: (r) => <b className="text-[var(--accent)]">{String((r.ratings as Player["ratings"]).overall)}</b> },
            { key: "pot", label: "潜力", render: (r) => { const rt = r.ratings as Player["ratings"]; return rt.potential != null ? `${rt.potentialLow}–${rt.potentialHigh}` : "未知"; } },
            { key: "role", label: "角色", render: (r) => ROLE_LABEL[String(r.role)] ?? String(r.role) },
            { key: "g", label: "出场", render: (r) => String(statLine(r as unknown as Player)?.g ?? 0) },
            { key: "ppg", label: "得分", render: (r) => fmtAvg(perG(statLine(r as unknown as Player)?.pts, statLine(r as unknown as Player)?.g)) },
            { key: "rpg", label: "篮板", render: (r) => fmtAvg(perG(statLine(r as unknown as Player)?.reb, statLine(r as unknown as Player)?.g)) },
            { key: "apg", label: "助攻", render: (r) => fmtAvg(perG(statLine(r as unknown as Player)?.ast, statLine(r as unknown as Player)?.g)) },
            { key: "salary", label: "薪资", render: (r) => fmtSalary((r as unknown as Player).contract.years[0]?.salary) },
            { key: "status", label: "状态", render: (r) => { const p = r as unknown as Player; return p.injury ? <span className="text-[var(--bad)]">伤停 {p.injury.weeksRemaining.toFixed(0)} 周</span> : <span className="text-[var(--good)]">健康</span>; } },
          ]}
        />
      </Section>

      {selected && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-start justify-center p-4 overflow-auto" onClick={() => setSelected(null)}>
          <div className="panel w-full max-w-2xl p-4 mt-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-3 gap-2 flex-wrap">
              <div>
                <div className="text-[16px] font-bold">
                  {selected.name}
                  <span className="text-[var(--text-dim)] text-[13px] font-normal ml-2">
                    {selected.position} · {selected.age}岁 · {selected.heightCm}cm / {selected.weightKg}kg
                  </span>
                </div>
                <div className="text-[12px] text-[var(--text-dim)] mt-1">
                  {ROLE_LABEL[selected.role] ?? selected.role} · 满意度 {selected.satisfaction.toFixed(0)} · 状态 {selected.status}
                  {selected.injury ? `（${selected.injury.description}，剩 ${selected.injury.weeksRemaining.toFixed(0)} 周）` : ""}
                </div>
              </div>
              <button className="btn" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="text-[12px] font-semibold text-[var(--text-dim)]">能力评分（可解释 · {selected.ratings.ratingVersion}）</div>
                <RatingBar label="综合" value={selected.ratings.overall} />
                <RatingBar label="篮下" value={selected.ratings.inside} />
                <RatingBar label="终结" value={selected.ratings.finishing} />
                <RatingBar label="投射" value={selected.ratings.threePoint} />
                <RatingBar label="罚球" value={selected.ratings.freeThrow} />
                <RatingBar label="组织" value={selected.ratings.playmaking} />
                <RatingBar label="篮板" value={selected.ratings.rebounding} />
                <RatingBar label="外防" value={selected.ratings.perimeterD} />
                <RatingBar label="内防" value={selected.ratings.interiorD} />
                <div className="text-[11px] text-[var(--text-dim)] leading-relaxed mt-2 panel-2 p-2">
                  潜力（球探估计区间）：{selected.ratings.potential != null ? `${selected.ratings.potentialLow}–${selected.ratings.potentialHigh}` : "未知 — 无球探报告数据"}
                  <br />
                  评分置信度：{(selected.ratings.confidence * 100).toFixed(0)}%（基于出场时间样本，非官方评分，由统计计算得出）
                  <br />
                  发展轨迹：{selected.development.trajectory} · 上季变化 {selected.development.lastDelta > 0 ? "+" : ""}
                  {selected.development.lastDelta}
                </div>
              </div>

              <div className="space-y-3">
                {selected.baselineStats && (
                  <div className="panel-2 p-2.5 mb-3">
                    <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1">
                      真实 {selected.baselineStats.season - 1}-{String(selected.baselineStats.season).slice(2)} 赛季数据（导入 · {selected.baselineStats.teamRow}）
                    </div>
                    <div className="text-[12px] leading-relaxed">
                      {selected.baselineStats.g} 场 · {selected.baselineStats.mpg.toFixed(1)} 分钟 · 得分 {selected.baselineStats.ppg.toFixed(1)} / 篮板{" "}
                      {selected.baselineStats.rpg.toFixed(1)} / 助攻 {selected.baselineStats.apg.toFixed(1)} / 抢断 {selected.baselineStats.spg.toFixed(1)} / 盖帽{" "}
                      {selected.baselineStats.bpg.toFixed(1)}
                      <br />
                      命中率 {selected.baselineStats.fgPct != null ? (selected.baselineStats.fgPct * 100).toFixed(1) + "%" : "未知"} · 三分{" "}
                      {selected.baselineStats.tpPct != null ? (selected.baselineStats.tpPct * 100).toFixed(1) + "%" : "未知"} · 罚球{" "}
                      {selected.baselineStats.ftPct != null ? (selected.baselineStats.ftPct * 100).toFixed(1) + "%" : "未知"}
                      <br />
                      <span className="text-[11px] text-[var(--text-dim)]">评分由以上真实数据计算（RATING-ENGINE v1.1），非官方评分。</span>
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1">本季原始统计</div>
                  {statLine(selected) ? (
                    <div className="text-[12px] leading-relaxed">
                      {statLine(selected)!.g} 场 · {(statLine(selected)!.mp / Math.max(1, statLine(selected)!.g)).toFixed(1)} 分钟 · 得分{" "}
                      {perG(statLine(selected)!.pts, statLine(selected)!.g).toFixed(1)} / 篮板 {perG(statLine(selected)!.reb, statLine(selected)!.g).toFixed(1)} / 助攻{" "}
                      {perG(statLine(selected)!.ast, statLine(selected)!.g).toFixed(1)} / 抢断 {perG(statLine(selected)!.stl, statLine(selected)!.g).toFixed(1)} / 盖帽{" "}
                      {perG(statLine(selected)!.blk, statLine(selected)!.g).toFixed(1)} / 失误 {perG(statLine(selected)!.tov, statLine(selected)!.g).toFixed(1)}
                      <br />
                      命中率 {((statLine(selected)!.fgm / Math.max(1, statLine(selected)!.fga)) * 100).toFixed(1)}% · 三分{" "}
                      {((statLine(selected)!.tpm / Math.max(1, statLine(selected)!.tpa)) * 100).toFixed(1)}% · 罚球{" "}
                      {((statLine(selected)!.ftm / Math.max(1, statLine(selected)!.fta)) * 100).toFixed(1)}%
                    </div>
                  ) : (
                    <div className="text-[12px] text-[var(--text-dim)]">本季暂无统计样本</div>
                  )}
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1">合同</div>
                  <div className="text-[12px] leading-relaxed">
                    {selected.contract.type}
                    {selected.contract.noTrade ? " · 含不可交易条款" : ""}
                    {selected.contract.option ? ` · ${selected.contract.option === "PO" ? "球员选项" : "球队选项"}` : ""}
                    <br />
                    {selected.contract.years.map((y) => (
                      <span key={y.season} className="mr-2">
                        {y.season - 1}-{String(y.season).slice(2)}: {fmtSalary(y.salary)}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1">数据来源</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <ProvenanceTag source={selected.source as import("@/domain/types").PlayerSource | null} />
                  </div>
                  {selected.source && (
                    <div className="text-[11px] text-[var(--text-dim)] mt-1 leading-relaxed">
                      provider: {selected.source.provider} · retrievedAt: {selected.source.retrievedAt ?? "未知"} · season: {selected.source.season ?? "未知"}
                      <br />
                      license: {selected.source.licenseNote}
                      {selected.source.sourceUrl ? (
                        <>
                          <br />
                          sourceUrl: {selected.source.sourceUrl}
                        </>
                      ) : null}
                    </div>
                  )}
                </div>

                {isGod && (
                  <div className="panel-2 p-2.5 border-[#dc2626]">
                    <div className="text-[12px] font-bold text-[#fca5a5] mb-2">GOD MODE 操作</div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn btn-god" onClick={() => godEdit("setRating", { playerId: selected.id, field: "overall", value: Number(window.prompt("新综合评分 (25-99)") ?? 0) })}>
                        改评分
                      </button>
                      <button className="btn btn-god" onClick={() => godEdit("setRating", { playerId: selected.id, field: "potential", value: Number(window.prompt("新潜力 (25-99)") ?? 0) })}>
                        改潜力
                      </button>
                      <button className="btn btn-god" onClick={() => godEdit("setAge", { playerId: selected.id, value: Number(window.prompt("新年龄") ?? 0) })}>
                        改年龄
                      </button>
                      <button className="btn btn-god" onClick={() => godEdit("setSatisfaction", { playerId: selected.id, value: Number(window.prompt("新满意度 (0-100)") ?? 0) })}>
                        改满意度
                      </button>
                      <button
                        className="btn btn-god"
                        onClick={() => godEdit("setContract", { playerId: selected.id, years: Number(window.prompt("合同年数") ?? 0), salary: Number(window.prompt("年薪 (M)") ?? 0) })}
                      >
                        改合同
                      </button>
                      <button className="btn btn-god" onClick={() => godEdit("setInjury", { playerId: selected.id, weeks: Number(window.prompt("伤停周数（0=清除）") ?? 0) })}>
                        改伤情
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
