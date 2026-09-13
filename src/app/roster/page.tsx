"use client";

// 阵容页 = 轮换管理界面：设置首发与出场时间，实时显示位置覆盖、球权、
// 投射、篮板、防守、疲劳等决策指标。球员完整评分/数据来源收进抽屉，
// 避免一次铺开所有字段。其他球队只读浏览。

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, useSave, ROLE_LABEL } from "@/components/save-context";
import { Section, RatingBar, ProvenanceTag, Toast, fmtSalary, fmtAvg } from "@/components/ui";

interface Player {
  id: string;
  name: string;
  teamId: string | null;
  teamAbbr: string | null;
  position: string;
  secondPosition: string | null;
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
    usageTendency: number;
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
  stamina: number;
  source: { provider: string; sourceUrl: string | null; retrievedAt: string | null; season: number | null; licenseNote: string; status: string; ratingVersion: string } | null;
}

interface TeamRow {
  id: string;
  abbr: string;
  city: string;
  name: string;
}

const POSITIONS = ["PG", "SG", "SF", "PF", "C"] as const;
const ROLE_MINUTES: Record<string, number> = { STAR: 35, STARTER: 32, SIXTH_MAN: 26, ROTATION: 14, BENCH: 6, STASH: 0 };

export default function RosterPage() {
  const { summary, saveId } = useSave();
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [teamId, setTeamId] = useState<string>("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Player | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const isGod = !!summary?.save.godMode;
  const isUserTeam = !!summary?.userTeam && teamId === summary.userTeam.id;

  // 轮换编辑状态
  const [starters, setStarters] = useState<string[]>([]);
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!saveId) return;
    api<{ teams: TeamRow[] }>(`/api/saves/${saveId}/teams`).then((j) => {
      setTeams(j.teams);
      if (!teamId && summary?.userTeam) setTeamId(summary.userTeam.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, summary?.userTeam?.id]);

  /** 未配置时按角色给出建议轮换（引擎同款逻辑的前端镜像）。 */
  const resetToAuto = (roster: Player[]) => {
    const avail = roster.filter((p) => p.status !== "INJURED" && !(p.injury && p.injury.weeksRemaining > 0));
    const rank: Record<string, number> = { STAR: 0, STARTER: 1, SIXTH_MAN: 2, ROTATION: 3, BENCH: 4, STASH: 5 };
    const sorted = [...avail].sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || b.ratings.overall - a.ratings.overall);
    setStarters(sorted.slice(0, 5).map((p) => p.id));
    const mins: Record<string, number> = {};
    for (const p of sorted.slice(0, 10)) mins[p.id] = ROLE_MINUTES[p.role] ?? 12;
    setMinutes(mins);
    setConfigured(false);
  };

  const load = useCallback(async () => {
    if (!saveId || !teamId) return;
    const j = await api<{ players: Player[] }>(`/api/saves/${saveId}/roster?teamId=${encodeURIComponent(`${saveId}:${teamId}`)}`);
    setPlayers(j.players);
    if (summary?.userTeam && teamId === summary.userTeam.id) {
      try {
        const r = await api<{ rotation: { starters?: string[]; minutes?: Record<string, number> } | null }>(`/api/saves/${saveId}/rotation?teamId=${encodeURIComponent(teamId)}`);
        if (r.rotation?.starters?.length === 5) {
          setStarters(r.rotation.starters);
          setMinutes(r.rotation.minutes ?? {});
          setConfigured(true);
        } else {
          resetToAuto(j.players);
        }
      } catch {
        resetToAuto(j.players);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStarter = (id: string) => {
    setConfigured(true);
    setStarters((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 5 ? [...s.slice(1), id] : [...s, id]));
  };

  const setMinute = (id: string, v: number) => {
    setConfigured(true);
    setMinutes((m) => ({ ...m, [id]: Math.max(0, Math.min(44, Math.round(v * 10) / 10)) }));
  };

  const autoBalance = () => {
    const avail = players.filter((p) => !p.injury || p.injury.weeksRemaining <= 0);
    const base: Record<string, number> = {};
    let used = 0;
    for (const id of starters) {
      const p = avail.find((x) => x.id === id);
      if (p) {
        base[id] = ROLE_MINUTES[p.role] ?? 32;
        used += base[id];
      }
    }
    const rest = avail.filter((p) => !starters.includes(p.id));
    const rank: Record<string, number> = { SIXTH_MAN: 26, ROTATION: 14, BENCH: 6, STASH: 0 };
    const sorted = [...rest].sort((a, b) => (rank[a.role] ?? 12) - (rank[b.role] ?? 12) || b.ratings.overall - a.ratings.overall);
    for (const p of sorted) {
      if (used >= 236) break;
      const m = Math.min(rank[p.role] ?? 12, 238 - used);
      if (m > 2) {
        base[p.id] = m;
        used += m;
      }
    }
    setMinutes(base);
    setConfigured(true);
    setToast({ msg: "已按角色生成建议分钟数，可继续微调。", kind: "ok" });
  };

  const saveRotation = async () => {
    if (starters.length !== 5) {
      setToast({ msg: "首发必须正好 5 人。", kind: "err" });
      return;
    }
    setSaving(true);
    try {
      await api(`/api/saves/${saveId}/rotation`, {
        method: "PUT",
        body: JSON.stringify({ teamId, starters, minutes }),
      });
      setToast({ msg: "轮换已保存，下一场比赛生效。", kind: "ok" });
      setConfigured(true);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setSaving(false);
    }
  };

  const resetRotation = async () => {
    try {
      await api(`/api/saves/${saveId}/rotation`, { method: "PUT", body: JSON.stringify({ teamId, reset: true }) });
      resetToAuto(players);
      setToast({ msg: "已恢复引擎自动轮换。", kind: "ok" });
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  // ---- 决策指标 ----
  const metrics = useMemo(() => {
    const avail = players.filter((p) => !p.injury || p.injury.weeksRemaining <= 0);
    const rotationIds = new Set([
      ...starters,
      ...Object.entries(minutes).filter(([id, m]) => m >= 8 && !starters.includes(id)).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id),
    ]);
    const rotation = players.filter((p) => rotationIds.has(p.id));
    const minutesSum = Object.values(minutes).reduce((a, b) => a + b, 0);
    const coverage = POSITIONS.map((pos) => {
      const hit = starters.some((id) => {
        const p = players.find((x) => x.id === id);
        return p && (p.position === pos || p.secondPosition === pos);
      });
      if (hit) return { pos, ok: true };
      // 轮换里能客串的球员
      const flex = rotation.find((p) => p.position === pos || p.secondPosition === pos);
      return { pos, ok: false, flex: flex?.name };
    });
    const usageSum = rotation.slice(0, 5).length ? starters.reduce((a, id) => {
      const p = players.find((x) => x.id === id);
      return a + (p?.ratings.usageTendency ?? 0);
    }, 0) : 0;
    const avgOf = (fn: (p: Player) => number) => (rotation.length ? rotation.reduce((a, p) => a + fn(p), 0) / rotation.length : 0);
    return {
      minutesSum,
      coverage,
      usageSum,
      spacing: avgOf((p) => p.ratings.threePoint),
      rebounding: avgOf((p) => p.ratings.rebounding),
      defense: avgOf((p) => (p.ratings.perimeterD + p.ratings.interiorD) / 2),
      playmaking: avgOf((p) => p.ratings.playmaking),
      stamina: avgOf((p) => p.stamina * 100),
      injuredStarters: starters.filter((id) => {
        const p = players.find((x) => x.id === id);
        return p && p.injury && p.injury.weeksRemaining > 0;
      }).length,
      rotationCount: rotation.length,
      availCount: avail.length,
    };
  }, [players, starters, minutes]);

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

  const bench = players.filter((p) => !starters.includes(p.id));
  const starterPlayers = starters.map((id) => players.find((p) => p.id === id)).filter(Boolean) as Player[];

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
        {isUserTeam && !configured && <span className="tag">自动轮换（未手动配置）</span>}
        {isUserTeam && configured && <span className="tag tag-imported">手动轮换已生效</span>}
        {isGod && <span className="tag tag-god">GOD MODE</span>}
      </div>

      {isUserTeam && (
        <>
          {/* 决策指标条 */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
            <Metric label="分钟合计" value={`${metrics.minutesSum.toFixed(0)}`} sub="目标 240" tone={Math.abs(metrics.minutesSum - 240) <= 6 ? "good" : metrics.minutesSum > 240 ? "bad" : "warn"} />
            <Metric
              label="位置覆盖"
              value={metrics.coverage.filter((c) => c.ok).length === 5 ? "5/5" : metrics.coverage.filter((c) => c.ok).length + "/5"}
              sub={metrics.coverage.filter((c) => !c.ok).map((c) => `${c.pos}${c.flex ? `(${c.flex}可客串)` : "缺位"}`).join(" ") || "全部覆盖"}
              tone={metrics.coverage.every((c) => c.ok) ? "good" : "warn"}
            />
            <Metric label="球权合计" value={`${(metrics.usageSum * 100).toFixed(0)}%`} sub={metrics.usageSum > 0.88 ? "过于拥挤" : metrics.usageSum < 0.55 ? "缺少得分点" : "分配合理"} tone={metrics.usageSum > 0.88 || metrics.usageSum < 0.5 ? "warn" : "good"} />
            <Metric label="投射空间" value={metrics.spacing.toFixed(0)} sub={metrics.spacing < 50 ? "轮换缺投手" : metrics.spacing > 68 ? "空间良好" : "联盟平均"} tone={metrics.spacing < 50 ? "bad" : "good"} />
            <Metric label="篮板" value={metrics.rebounding.toFixed(0)} sub={metrics.rebounding < 60 ? "偏弱，会被冲抢" : "合格"} tone={metrics.rebounding < 60 ? "warn" : "good"} />
            <Metric label="防守" value={metrics.defense.toFixed(0)} sub={metrics.defense < 60 ? "有被针对风险" : "合格"} tone={metrics.defense < 60 ? "warn" : "good"} />
            <Metric label="平均体力" value={`${metrics.stamina.toFixed(0)}%`} sub={metrics.injuredStarters > 0 ? `${metrics.injuredStarters} 名首发伤停!` : metrics.stamina < 75 ? "注意背靠背风险" : "状态良好"} tone={metrics.injuredStarters > 0 ? "bad" : metrics.stamina < 75 ? "warn" : "good"} />
          </div>

          {/* 首发 */}
          <Section
            title={`首发（${starters.length}/5）— 点击行设为/取消首发`}
            right={
              <div className="flex gap-2">
                <button className="btn text-[12px] py-1" onClick={autoBalance}>按角色填分钟</button>
                <button className="btn text-[12px] py-1" onClick={resetRotation}>恢复自动</button>
                <button className="btn btn-primary text-[12px] py-1" onClick={saveRotation} disabled={saving || starters.length !== 5}>
                  {saving ? "保存中…" : "保存轮换"}
                </button>
              </div>
            }
          >
            <div className="grid md:grid-cols-5 gap-2">
              {starterPlayers.map((p) => (
                <div key={p.id} className="panel-2 p-2.5">
                  <div className="flex items-center justify-between gap-1">
                    <button className="text-[13px] font-semibold hover:text-[var(--accent)]" onClick={() => toggleStarter(p.id)}>
                      {p.name}
                    </button>
                    <span className="text-[16px] font-bold text-[var(--accent)] tabular-nums">{p.ratings.overall}</span>
                  </div>
                  <div className="text-[11px] text-[var(--text-dim)] mt-0.5">
                    {p.position} · {ROLE_LABEL[p.role] ?? p.role}
                    {p.injury && <span className="text-[var(--bad)]"> · 伤停</span>}
                    {p.stamina < 0.75 && <span className="text-[var(--warn)]"> · 体力 {Math.round(p.stamina * 100)}%</span>}
                  </div>
                  <label className="flex items-center gap-2 mt-1.5 text-[11px] text-[var(--text-dim)]">
                    时间
                    <input
                      type="number"
                      className="input !py-0.5 !px-1.5 w-16 text-[12px]"
                      value={minutes[p.id] ?? 0}
                      min={0}
                      max={44}
                      step={1}
                      onChange={(e) => setMinute(p.id, Number(e.target.value))}
                    />
                    分钟
                  </label>
                  <button className="text-[11px] text-[var(--accent)] mt-1" onClick={() => setSelected(p)}>
                    详情 →
                  </button>
                </div>
              ))}
              {Array.from({ length: Math.max(0, 5 - starterPlayers.length) }).map((_, i) => (
                <div key={`empty-${i}`} className="panel-2 p-2.5 text-[12px] text-[var(--text-dim)] border-dashed border flex items-center justify-center min-h-[92px]">
                  从下方替补中点「首发」
                </div>
              ))}
            </div>
          </Section>

          {/* 替补与轮换 */}
          <Section title={`替补与轮换（出场时间 0 = 不进轮换）`}>
            <div className="scrollbox max-h-[420px]">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>球员</th>
                    <th>位置</th>
                    <th>综合</th>
                    <th>角色</th>
                    <th>组织</th>
                    <th>投射</th>
                    <th>篮板</th>
                    <th>防守</th>
                    <th>体力</th>
                    <th>时间</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {[...bench]
                    .sort((a, b) => b.ratings.overall - a.ratings.overall)
                    .map((p) => (
                      <tr key={p.id}>
                        <td>
                          <button className="btn !py-0.5 !px-1.5 text-[11px]" onClick={() => toggleStarter(p.id)} disabled={!!p.injury && p.injury.weeksRemaining > 0} title={p.injury ? "伤停球员不能首发" : "设为首发"}>
                            首发
                          </button>
                        </td>
                        <td>
                          <button className="font-medium hover:text-[var(--accent)]" onClick={() => setSelected(p)}>
                            {p.name}
                          </button>
                        </td>
                        <td>{p.position}</td>
                        <td className="text-[var(--accent)] font-semibold">{p.ratings.overall}</td>
                        <td className="text-[var(--text-dim)]">{ROLE_LABEL[p.role] ?? p.role}</td>
                        <td>{p.ratings.playmaking}</td>
                        <td>{p.ratings.threePoint}</td>
                        <td>{p.ratings.rebounding}</td>
                        <td>{Math.round((p.ratings.perimeterD + p.ratings.interiorD) / 2)}</td>
                        <td className={p.stamina < 0.7 ? "text-[var(--bad)]" : "text-[var(--text-dim)]"}>{Math.round(p.stamina * 100)}%</td>
                        <td>
                          <input
                            type="number"
                            className="input !py-0.5 !px-1.5 w-14 text-[12px]"
                            value={minutes[p.id] ?? 0}
                            min={0}
                            max={44}
                            step={1}
                            onChange={(e) => setMinute(p.id, Number(e.target.value))}
                          />
                        </td>
                        <td>{p.injury ? <span className="text-[var(--bad)]">伤停 {p.injury.weeksRemaining.toFixed(0)} 周</span> : <span className="text-[var(--good)]">健康</span>}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      {!isUserTeam && (
        <Section title={`阵容（${players.length} 人）— 只读浏览`}>
          <div className="scrollbox">
            <table className="data">
              <thead>
                <tr>
                  <th>球员</th>
                  <th>位置</th>
                  <th>年龄</th>
                  <th>综合</th>
                  <th>角色</th>
                  <th>得分</th>
                  <th>篮板</th>
                  <th>助攻</th>
                  <th>薪资</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {[...players]
                  .sort((a, b) => b.ratings.overall - a.ratings.overall)
                  .map((p) => (
                    <tr key={p.id} onClick={() => setSelected(p)} style={{ cursor: "pointer" }}>
                      <td className="font-medium">{p.name}</td>
                      <td>{p.position}</td>
                      <td>{p.age}</td>
                      <td className="text-[var(--accent)] font-semibold">{p.ratings.overall}</td>
                      <td className="text-[var(--text-dim)]">{ROLE_LABEL[p.role] ?? p.role}</td>
                      <td>{fmtAvg(perG(statLine(p)?.pts, statLine(p)?.g))}</td>
                      <td>{fmtAvg(perG(statLine(p)?.reb, statLine(p)?.g))}</td>
                      <td>{fmtAvg(perG(statLine(p)?.ast, statLine(p)?.g))}</td>
                      <td>{fmtSalary(p.contract.years[0]?.salary)}</td>
                      <td>{p.injury ? <span className="text-[var(--bad)]">伤停</span> : <span className="text-[var(--good)]">健康</span>}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* 球员详情抽屉 */}
      {selected && <PlayerDrawer player={selected} onClose={() => setSelected(null)} isGod={isGod} godEdit={godEdit} />}
      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-[var(--bad)]" : tone === "warn" ? "text-[var(--warn)]" : tone === "good" ? "text-[var(--good)]" : "";
  return (
    <div className="panel p-2.5">
      <div className="text-[11px] text-[var(--text-dim)]">{label}</div>
      <div className={`text-[18px] font-bold tabular-nums mt-0.5 ${color}`}>{value}</div>
      {sub && <div className="text-[10.5px] text-[var(--text-dim)] mt-0.5 leading-tight">{sub}</div>}
    </div>
  );
}

function PlayerDrawer({
  player: p,
  onClose,
  isGod,
  godEdit,
}: {
  player: Player;
  onClose: () => void;
  isGod: boolean;
  godEdit: (op: string, params: Record<string, unknown>) => Promise<void>;
}) {
  const statLine = p.seasonStats[0];
  const perG = (v: number, g: number) => (g > 0 ? v / g : 0);
  return (
    <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose}>
      <div
        className="absolute right-0 top-0 h-full w-full max-w-xl bg-[var(--bg-panel)] border-l border-[var(--border)] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3 gap-2 flex-wrap sticky top-0 bg-[var(--bg-panel)] pb-2 z-10">
          <div>
            <div className="text-[16px] font-bold">
              {p.name}
              <span className="text-[var(--text-dim)] text-[13px] font-normal ml-2">
                {p.position} · {p.age}岁 · {p.heightCm}cm / {p.weightKg}kg
              </span>
            </div>
            <div className="text-[12px] text-[var(--text-dim)] mt-1">
              {ROLE_LABEL[p.role] ?? p.role} · 满意度 {p.satisfaction.toFixed(0)} · 体力 {Math.round(p.stamina * 100)}%
              {p.injury ? ` · ${p.injury.description}（剩 ${p.injury.weeksRemaining.toFixed(0)} 周）` : " · 健康"}
            </div>
          </div>
          <button className="btn" onClick={onClose}>
            关闭 ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1.5">能力评分（可解释 · {p.ratings.ratingVersion}）</div>
            <RatingBar label="综合" value={p.ratings.overall} />
            <RatingBar label="篮下" value={p.ratings.inside} />
            <RatingBar label="终结" value={p.ratings.finishing} />
            <RatingBar label="投射" value={p.ratings.threePoint} />
            <RatingBar label="罚球" value={p.ratings.freeThrow} />
            <RatingBar label="组织" value={p.ratings.playmaking} />
            <RatingBar label="篮板" value={p.ratings.rebounding} />
            <RatingBar label="外防" value={p.ratings.perimeterD} />
            <RatingBar label="内防" value={p.ratings.interiorD} />
            <div className="text-[11px] text-[var(--text-dim)] leading-relaxed mt-2 panel-2 p-2">
              潜力区间：{p.ratings.potential != null ? `${p.ratings.potentialLow}–${p.ratings.potentialHigh}` : "未知 — 无球探报告数据"}
              <br />
              评分置信度：{(p.ratings.confidence * 100).toFixed(0)}%（基于出场样本计算，非官方评分）
              <br />
              发展轨迹：{p.development.trajectory} · 上季变化 {p.development.lastDelta > 0 ? "+" : ""}
              {p.development.lastDelta}
            </div>
          </div>

          {p.baselineStats && (
            <div className="panel-2 p-2.5">
              <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1">
                真实 {p.baselineStats.season - 1}-{String(p.baselineStats.season).slice(2)} 赛季数据（导入 · {p.baselineStats.teamRow}）
              </div>
              <div className="text-[12px] leading-relaxed">
                {p.baselineStats.g} 场 · {p.baselineStats.mpg.toFixed(1)} 分钟 · {p.baselineStats.ppg.toFixed(1)} 分 / {p.baselineStats.rpg.toFixed(1)} 板 / {p.baselineStats.apg.toFixed(1)} 助
                <br />
                命中率 {p.baselineStats.fgPct != null ? (p.baselineStats.fgPct * 100).toFixed(1) + "%" : "未知"} · 三分{" "}
                {p.baselineStats.tpPct != null ? (p.baselineStats.tpPct * 100).toFixed(1) + "%" : "未知"} · 罚球{" "}
                {p.baselineStats.ftPct != null ? (p.baselineStats.ftPct * 100).toFixed(1) + "%" : "未知"}
              </div>
            </div>
          )}

          <div>
            <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1">本季统计</div>
            {statLine ? (
              <div className="text-[12px] leading-relaxed">
                {statLine.g} 场 · {(statLine.mp / Math.max(1, statLine.g)).toFixed(1)} 分钟 · {perG(statLine.pts, statLine.g).toFixed(1)} 分 / {perG(statLine.reb, statLine.g).toFixed(1)} 板 / {perG(statLine.ast, statLine.g).toFixed(1)} 助 / 失误{" "}
                {perG(statLine.tov, statLine.g).toFixed(1)}
                <br />
                命中率 {((statLine.fgm / Math.max(1, statLine.fga)) * 100).toFixed(1)}% · 三分 {((statLine.tpm / Math.max(1, statLine.tpa)) * 100).toFixed(1)}% · 罚球 {((statLine.ftm / Math.max(1, statLine.fta)) * 100).toFixed(1)}%
              </div>
            ) : (
              <div className="text-[12px] text-[var(--text-dim)]">本季暂无统计样本</div>
            )}
          </div>

          <div>
            <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1">合同</div>
            <div className="text-[12px] leading-relaxed">
              {p.contract.type}
              {p.contract.noTrade ? " · 含不可交易条款" : ""}
              {p.contract.option ? ` · ${p.contract.option === "PO" ? "球员选项" : "球队选项"}` : ""}
              <br />
              {p.contract.years.map((y) => (
                <span key={y.season} className="mr-2">
                  {y.season - 1}-{String(y.season).slice(2)}: {fmtSalary(y.salary)}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[12px] font-semibold text-[var(--text-dim)] mb-1">数据来源</div>
            <ProvenanceTag source={p.source as import("@/domain/types").PlayerSource | null} />
            {p.source && (
              <div className="text-[11px] text-[var(--text-dim)] mt-1 leading-relaxed">
                {p.source.sourceUrl} · {p.source.licenseNote}
              </div>
            )}
          </div>

          {isGod && (
            <div className="panel-2 p-2.5 border-[#dc2626]">
              <div className="text-[12px] font-bold text-[#fca5a5] mb-2">GOD MODE 操作</div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-god" onClick={() => godEdit("setRating", { playerId: p.id, field: "overall", value: Number(window.prompt("新综合评分 (25-99)") ?? 0) })}>
                  改评分
                </button>
                <button className="btn btn-god" onClick={() => godEdit("setRating", { playerId: p.id, field: "potential", value: Number(window.prompt("新潜力 (25-99)") ?? 0) })}>
                  改潜力
                </button>
                <button className="btn btn-god" onClick={() => godEdit("setAge", { playerId: p.id, value: Number(window.prompt("新年龄") ?? 0) })}>
                  改年龄
                </button>
                <button className="btn btn-god" onClick={() => godEdit("setSatisfaction", { playerId: p.id, value: Number(window.prompt("新满意度 (0-100)") ?? 0) })}>
                  改满意度
                </button>
                <button className="btn btn-god" onClick={() => godEdit("setContract", { playerId: p.id, years: Number(window.prompt("合同年数") ?? 0), salary: Number(window.prompt("年薪 (M)") ?? 0) })}>
                  改合同
                </button>
                <button className="btn btn-god" onClick={() => godEdit("setInjury", { playerId: p.id, weeks: Number(window.prompt("伤停周数（0=清除）") ?? 0) })}>
                  改伤情
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
