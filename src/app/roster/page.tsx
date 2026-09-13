"use client";

// 轮换与阵容页：2K 式位置槽位模型。
// 首发按 PG/SG/SF/PF/C 五个槽位组织——点槽位卡选人（本位置→可客串→其他），
// 替补「提上首发」后点目标槽位即完成对换（分钟随身份互换），分钟分配 + 位置
// 深度图辅助决策。引擎同样按这套槽位生成默认首发，所见即所模拟。
// 其他球队为只读浏览（展示引擎自动轮换）。球员评分/溯源收进详情抽屉。

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, useSave, ROLE_LABEL } from "@/components/save-context";
import { Section, RatingBar, ProvenanceTag, Toast, fmtSalary, fmtAvg } from "@/components/ui";
import { LINEUP_POSITIONS, assignStarters, placeIntoSlots, positionFit, positionLabel } from "@/domain/positions";

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

const MINUTES_TARGET = 240;
const POS_COLORS: Record<string, string> = { PG: "#38bdf8", SG: "#34d399", SF: "#fbbf24", PF: "#fb923c", C: "#c084fc" };

const isHealthy = (p: Player) => p.status !== "INJURED" && !(p.injury && p.injury.weeksRemaining > 0);

/** 一键排兵/未配置时展示的轮换：位置槽首发 + 按能力分档的 240 分钟。 */
function autoMinutes(slotList: (Player | null)[], roster: Player[]): Record<string, number> {
  const mins: Record<string, number> = {};
  for (const p of roster) mins[p.id] = 0;
  const starters = slotList.filter((p): p is Player => !!p);
  const bench = roster.filter((p) => isHealthy(p) && !starters.some((s) => s.id === p.id));
  const sRank = [...starters].sort((a, b) => b.ratings.overall - a.ratings.overall);
  const bRank = [...bench].sort((a, b) => b.ratings.overall - a.ratings.overall);
  const S = [36, 34.5, 33, 32, 30.5];
  const B = [23, 17, 13, 9, 6];
  const w: Record<string, number> = {};
  sRank.forEach((p, i) => (w[p.id] = S[Math.min(i, S.length - 1)]));
  bRank.forEach((p, i) => (w[p.id] = i < B.length ? B[i] : 0));
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  const scale = MINUTES_TARGET / Math.max(1, sum);
  let rsum = 0;
  for (const id in w) {
    w[id] = w[id] > 0 ? Math.round(w[id] * scale) : 0;
    rsum += w[id];
  }
  const top = sRank[0]?.id ?? bRank[0]?.id;
  if (top) w[top] = Math.max(0, w[top] + (MINUTES_TARGET - rsum));
  return w;
}

export default function RosterPage() {
  const { summary, saveId } = useSave();
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [teamId, setTeamId] = useState<string>("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Player | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const isGod = !!summary?.save.godMode;
  const isUserTeam = !!summary?.userTeam && teamId === summary.userTeam.id;

  // 轮换编辑状态：slots[i] 对应 LINEUP_POSITIONS[i] 槽位
  const [slots, setSlots] = useState<(Player | null)[]>([null, null, null, null, null]);
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false); // 服务端已有手动配置
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<Player | null>(null); // 待放上首发的替补

  useEffect(() => {
    if (!saveId) return;
    api<{ teams: TeamRow[] }>(`/api/saves/${saveId}/teams`).then((j) => {
      setTeams(j.teams);
      if (!teamId && summary?.userTeam) setTeamId(summary.userTeam.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, summary?.userTeam?.id]);

  /** 用引擎同款槽位分配生成「自动轮换」视图（不落库）。 */
  const applyAuto = (roster: Player[]) => {
    const healthy = roster.filter(isHealthy);
    const auto = assignStarters(healthy);
    setSlots(auto);
    setMinutes(autoMinutes(auto, roster));
  };

  const load = useCallback(async () => {
    if (!saveId || !teamId) return;
    const j = await api<{ players: Player[] }>(`/api/saves/${saveId}/roster?teamId=${encodeURIComponent(`${saveId}:${teamId}`)}`);
    setPlayers(j.players);
    setDirty(false);
    setPickerSlot(null);
    setPromoting(null);
    if (summary?.userTeam && teamId === summary.userTeam.id) {
      try {
        const r = await api<{ rotation: { starters?: string[]; minutes?: Record<string, number> } | null }>(`/api/saves/${saveId}/rotation?teamId=${encodeURIComponent(teamId)}`);
        if (r.rotation?.starters?.length === 5) {
          setSlots(placeIntoSlots(j.players, r.rotation.starters));
          const mins: Record<string, number> = {};
          for (const p of j.players) mins[p.id] = 0;
          Object.assign(mins, r.rotation.minutes ?? {});
          setMinutes(mins);
          setSaved(true);
          return;
        }
      } catch {
        /* fall through to auto */
      }
      setSaved(false);
      applyAuto(j.players);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const slotIndexOf = (id: string) => slots.findIndex((p) => p?.id === id);

  /** 把球员放进槽位：若他已是其他槽位首发→两槽对换；若是替补→与原槽位球员对换身份与分钟。 */
  const assignToSlot = (slotIdx: number, player: Player) => {
    const displaced = slots[slotIdx];
    const fromSlot = slotIndexOf(player.id);
    if (fromSlot === slotIdx) return;
    const next = [...slots];
    if (fromSlot >= 0) next[fromSlot] = displaced ?? null;
    next[slotIdx] = player;
    // 分钟随身份互换：进槽者拿到槽位分钟，被换下者继承其原分钟。
    const m = { ...minutes };
    const inMin = m[player.id] ?? 0;
    const outMin = displaced ? (m[displaced.id] ?? 0) : 0;
    if (displaced) {
      m[player.id] = outMin > 0 ? outMin : 32;
      m[displaced.id] = inMin;
    } else {
      m[player.id] = inMin > 0 ? inMin : 32;
    }
    setSlots(next);
    setMinutes(m);
    setDirty(true);
    setPickerSlot(null);
    setPromoting(null);
  };

  const clearSlot = (slotIdx: number) => {
    setDirty(true);
    setSlots((prev) => {
      const next = [...prev];
      next[slotIdx] = null;
      return next;
    });
  };

  const setMinute = (id: string, v: number) => {
    setDirty(true);
    setMinutes((m) => ({ ...m, [id]: Math.max(0, Math.min(44, Math.round(v))) }));
  };

  const saveRotation = async () => {
    const starters = slots.map((p) => p?.id);
    if (starters.some((s) => !s)) {
      setToast({ msg: "首发 5 个位置必须全部填满。", kind: "err" });
      return;
    }
    setSaving(true);
    try {
      await api(`/api/saves/${saveId}/rotation`, {
        method: "PUT",
        body: JSON.stringify({ teamId, starters, minutes }),
      });
      setToast({ msg: "轮换已保存，下一场比赛生效。", kind: "ok" });
      setSaved(true);
      setDirty(false);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setSaving(false);
    }
  };

  const resetRotation = async () => {
    try {
      await api(`/api/saves/${saveId}/rotation`, { method: "PUT", body: JSON.stringify({ teamId, reset: true }) });
      applyAuto(players);
      setSaved(false);
      setDirty(false);
      setToast({ msg: "已恢复引擎自动轮换。", kind: "ok" });
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  // ---- 决策指标 ----
  const metrics = useMemo(() => {
    const healthy = players.filter(isHealthy);
    const rotationIds = new Set([
      ...slots.filter(Boolean).map((p) => p!.id),
      ...Object.entries(minutes)
        .filter(([id, m]) => m >= 8 && slotIndexOf(id) < 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([id]) => id),
    ]);
    const rotation = players.filter((p) => rotationIds.has(p.id));
    const minutesSum = Object.values(minutes).reduce((a, b) => a + b, 0);
    const avgOf = (fn: (p: Player) => number) => (rotation.length ? rotation.reduce((a, p) => a + fn(p), 0) / rotation.length : 0);
    return {
      minutesSum,
      fit: slots.map((p, i) => (p ? positionFit(p, LINEUP_POSITIONS[i]) : -1)),
      usageSum: slots.reduce((a, p) => a + (p?.ratings.usageTendency ?? 0), 0),
      spacing: avgOf((p) => p.ratings.threePoint),
      rebounding: avgOf((p) => p.ratings.rebounding),
      defense: avgOf((p) => (p.ratings.perimeterD + p.ratings.interiorD) / 2),
      stamina: avgOf((p) => p.stamina * 100),
      injuredStarters: slots.filter((p) => p && !isHealthy(p)).length,
      rotationCount: rotation.length,
      healthyCount: healthy.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, slots, minutes]);

  const godEdit = async (op: string, params: Record<string, unknown>) => {
    try {
      await api(`/api/saves/${saveId}/god`, { method: "POST", body: JSON.stringify({ op, params }) });
      setToast({ msg: "GOD 操作完成（已写入审计日志）", kind: "ok" });
      await load();
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  const waive = async (p: Player) => {
    const salary = p.contract.years[0]?.salary ?? 0;
    const years = p.contract.years.length;
    if (!window.confirm(`确定裁掉 ${p.name}？剩余 ${years} 年合同（${salary}M/年）将变为死钱，仍占工资帽。`)) return;
    try {
      const r = await api<{ waived: string; total: number }>(`/api/saves/${saveId}/roster`, { method: "POST", body: JSON.stringify({ action: "waive", playerId: p.id }) });
      setToast({ msg: `已裁掉 ${r.waived}，死钱共 ${r.total.toFixed(1)}M 计入工资帽`, kind: "ok" });
      setSelected(null);
      await load();
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  const statLine = (p: Player) => p.seasonStats[0];
  const perG = (v: number | undefined, g: number | undefined) => (g && g > 0 ? (v ?? 0) / g : 0);

  // 其他球队只读：展示引擎自动轮换（与模拟默认首发同一套逻辑）。
  const autoSlots = useMemo(() => (isUserTeam ? slots : assignStarters(players.filter(isHealthy))), [players, isUserTeam, slots]);

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;

  const bench = players
    .filter((p) => slotIndexOf(p.id) < 0)
    .sort((a, b) => (minutes[b.id] ?? 0) - (minutes[a.id] ?? 0) || b.ratings.overall - a.ratings.overall);
  const fullStarters = slots.every(Boolean);

  const onTeamChange = (next: string) => {
    if (dirty && !window.confirm("有未保存的轮换改动，切换球队将丢弃。继续？")) return;
    setTeamId(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <select className="input max-w-56" value={teamId} onChange={(e) => onTeamChange(e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.city} {t.name}
            </option>
          ))}
        </select>
        {isUserTeam && !saved && <span className="tag">自动轮换（引擎按位置生成）</span>}
        {isUserTeam && saved && !dirty && <span className="tag tag-imported">手动轮换已生效</span>}
        {isUserTeam && dirty && <span className="tag tag-demo">有未保存改动</span>}
        {isGod && <span className="tag tag-god">GOD MODE</span>}
        {isUserTeam && (
          <div className="flex gap-2 ml-auto">
            <button
              className="btn text-[12px] py-1.5"
              onClick={() => {
                applyAuto(players);
                setDirty(true);
              }}
              title="按位置槽位自动安排首发与分钟，可再微调后保存"
            >
              ✨ 一键排兵
            </button>
            <button className="btn text-[12px] py-1.5" onClick={resetRotation} title="删除手动配置，回到引擎自动轮换">
              恢复自动
            </button>
            <button className="btn btn-primary text-[12px] py-1.5" onClick={saveRotation} disabled={saving || !fullStarters || !dirty}>
              {saving ? "保存中…" : dirty ? "保存轮换" : "已保存"}
            </button>
          </div>
        )}
      </div>

      {isUserTeam && (
        <>
          {/* 决策指标条 */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
            <Metric label="分钟合计" value={`${metrics.minutesSum}`} sub={`目标 ${MINUTES_TARGET}`} tone={Math.abs(metrics.minutesSum - MINUTES_TARGET) <= 6 ? "good" : metrics.minutesSum > MINUTES_TARGET ? "bad" : "warn"} />
            <Metric
              label="位置契合"
              value={`${metrics.fit.filter((f) => f >= 1).length}/5`}
              sub={slots.map((p, i) => (p && positionFit(p, LINEUP_POSITIONS[i]) === 0 ? `${LINEUP_POSITIONS[i]}错位` : null)).filter(Boolean).join(" ") || (metrics.fit.every((f) => f === 2) ? "全部本位置" : "有客串")}
              tone={metrics.fit.every((f) => f >= 1) ? "good" : "warn"}
            />
            <Metric label="球权合计" value={`${(metrics.usageSum * 100).toFixed(0)}%`} sub={metrics.usageSum > 0.88 ? "过于拥挤" : metrics.usageSum < 0.55 ? "缺少得分点" : "分配合理"} tone={metrics.usageSum > 0.88 || metrics.usageSum < 0.5 ? "warn" : "good"} />
            <Metric label="投射空间" value={metrics.spacing.toFixed(0)} sub={metrics.spacing < 50 ? "轮换缺投手" : metrics.spacing > 68 ? "空间良好" : "联盟平均"} tone={metrics.spacing < 50 ? "bad" : "good"} />
            <Metric label="篮板" value={metrics.rebounding.toFixed(0)} sub={metrics.rebounding < 60 ? "偏弱，会被冲抢" : "合格"} tone={metrics.rebounding < 60 ? "warn" : "good"} />
            <Metric label="防守" value={metrics.defense.toFixed(0)} sub={metrics.defense < 60 ? "有被针对风险" : "合格"} tone={metrics.defense < 60 ? "warn" : "good"} />
            <Metric label="平均体力" value={`${metrics.stamina.toFixed(0)}%`} sub={metrics.injuredStarters > 0 ? `${metrics.injuredStarters} 名首发伤停!` : metrics.stamina < 75 ? "注意背靠背风险" : "状态良好"} tone={metrics.injuredStarters > 0 ? "bad" : metrics.stamina < 75 ? "warn" : "good"} />
          </div>

          {/* 首发五槽 */}
          <Section title="首发阵容 — 点击位置卡片选人/调整" right={promoting ? <span className="text-[12px] text-[var(--warn)]">把 {promoting.name} 放到哪个位置？点击卡片（<button className="underline" onClick={() => setPromoting(null)}>取消</button>）</span> : undefined}>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {LINEUP_POSITIONS.map((pos, i) => {
                const p = slots[i];
                const fit = p ? positionFit(p, pos) : -1;
                const highlight = promoting ? (positionFit(promoting, pos) > 0 ? "ring-2 ring-[var(--accent)]" : "opacity-80") : pickerSlot === i ? "ring-2 ring-[var(--accent)]" : "";
                return (
                  <div key={pos} className={`panel-2 p-2.5 cursor-pointer hover:border-[var(--accent)] ${highlight}`} onClick={() => (promoting ? assignToSlot(i, promoting) : setPickerSlot(pickerSlot === i ? null : i))}>
                    <div className="flex items-center justify-between">
                      <span className="text-[15px] font-black tracking-wide" style={{ color: POS_COLORS[pos] }}>
                        {pos}
                      </span>
                      {p && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${fit === 2 ? "text-[var(--good)]" : fit === 1 ? "text-[var(--warn)]" : "text-[var(--bad)]"}`}>
                          {fit === 2 ? "本位置" : fit === 1 ? "可客串" : "错位"}
                        </span>
                      )}
                    </div>
                    {p ? (
                      <>
                        <button
                          className="text-[13px] font-semibold hover:text-[var(--accent)] mt-0.5 leading-tight text-left"
                          onClick={(e) => {
                            if (promoting) return; // 提上首发模式下让点击冒泡到卡片完成落位
                            e.stopPropagation();
                            setSelected(p);
                          }}
                        >
                          {p.name}
                        </button>
                        <div className="text-[11px] text-[var(--text-dim)] mt-0.5">
                          <PosLabel p={p} /> · <span className="text-[var(--accent)] font-bold">{p.ratings.overall}</span>
                          {!isHealthy(p) && <span className="text-[var(--bad)]"> · 伤停{p.injury ? `${p.injury.weeksRemaining.toFixed(0)}周` : ""}</span>}
                          {isHealthy(p) && p.stamina < 0.75 && <span className="text-[var(--warn)]"> · 体力 {Math.round(p.stamina * 100)}%</span>}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
                          <button className="btn !px-1.5 !py-0 text-[11px]" onClick={() => setMinute(p.id, (minutes[p.id] ?? 0) - 2)}>
                            −
                          </button>
                          <input type="number" className="input !py-0.5 !px-1 w-14 text-center text-[12px]" value={minutes[p.id] ?? 0} min={0} max={44} onChange={(e) => setMinute(p.id, Number(e.target.value))} />
                          <button className="btn !px-1.5 !py-0 text-[11px]" onClick={() => setMinute(p.id, (minutes[p.id] ?? 0) + 2)}>
                            +
                          </button>
                          <span className="text-[10.5px] text-[var(--text-dim)]">分钟</span>
                          <button className="text-[10.5px] text-[var(--text-dim)] hover:text-[var(--bad)] ml-auto" title="移出首发" onClick={() => clearSlot(i)}>
                            ✕
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="text-[12px] text-[var(--text-dim)] border border-dashed border-[var(--border)] rounded mt-1 py-3 text-center">点击选择球员</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 槽位选人面板 */}
            {pickerSlot !== null && (
              <div className="panel-2 p-3 mt-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-semibold">
                    为 <span style={{ color: POS_COLORS[LINEUP_POSITIONS[pickerSlot]] }}>{LINEUP_POSITIONS[pickerSlot]}</span> 选择球员
                  </span>
                  <button className="text-[12px] text-[var(--text-dim)] hover:text-[var(--text)]" onClick={() => setPickerSlot(null)}>
                    收起 ✕
                  </button>
                </div>
                <div className="grid md:grid-cols-3 gap-3">
                  {(
                    [
                      { label: "本位置", fit: 2 },
                      { label: "可客串", fit: 1 },
                      { label: "其他球员", fit: 0 },
                    ] as const
                  ).map((g) => {
                    const slot = LINEUP_POSITIONS[pickerSlot];
                    const list = players.filter((p) => isHealthy(p) && positionFit(p, slot) === g.fit).sort((a, b) => b.ratings.overall - a.ratings.overall);
                    return (
                      <div key={g.label}>
                        <div className="text-[11px] text-[var(--text-dim)] mb-1">
                          {g.label}（{list.length}）
                        </div>
                        <div className="space-y-0.5 max-h-56 overflow-y-auto scrollbox">
                          {list.map((p) => {
                            const curSlot = slotIndexOf(p.id);
                            return (
                              <button key={p.id} className="w-full text-left px-2 py-1 rounded hover:bg-[var(--bg-panel)] flex items-center gap-2 text-[12px]" onClick={() => assignToSlot(pickerSlot, p)}>
                                <span className="font-medium truncate flex-1">{p.name}</span>
                                <PosLabel p={p} dim />
                                <span className="text-[var(--accent)] font-semibold tabular-nums">{p.ratings.overall}</span>
                                <span className="text-[10.5px] text-[var(--text-dim)] tabular-nums w-12 text-right">{curSlot >= 0 ? `现${LINEUP_POSITIONS[curSlot]}·` : ""}{minutes[p.id] ?? 0}分</span>
                              </button>
                            );
                          })}
                          {list.length === 0 && <div className="text-[11px] text-[var(--text-dim)] px-2 py-1">无</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Section>

          {/* 替补席 */}
          <Section title="替补席 — 「提上首发」后点击目标位置完成对换；分钟 0 = 不进轮换">
            <div className="scrollbox max-h-[380px]">
              <table className="data">
                <thead>
                  <tr>
                    <th>球员</th>
                    <th>可打位置</th>
                    <th>综合</th>
                    <th>角色</th>
                    <th>组织</th>
                    <th>投射</th>
                    <th>防守</th>
                    <th>体力</th>
                    <th style={{ width: 110 }}>分钟</th>
                    <th>状态</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {bench.map((p) => {
                    const hurt = !isHealthy(p);
                    return (
                      <tr key={p.id} className={hurt ? "opacity-60" : ""}>
                        <td>
                          <button className="font-medium hover:text-[var(--accent)]" onClick={() => setSelected(p)}>
                            {p.name}
                          </button>
                        </td>
                        <td>
                          <PosLabel p={p} />
                        </td>
                        <td className="text-[var(--accent)] font-semibold">{p.ratings.overall}</td>
                        <td className="text-[var(--text-dim)]">{ROLE_LABEL[p.role] ?? p.role}</td>
                        <td>{p.ratings.playmaking}</td>
                        <td>{p.ratings.threePoint}</td>
                        <td>{Math.round((p.ratings.perimeterD + p.ratings.interiorD) / 2)}</td>
                        <td className={p.stamina < 0.7 ? "text-[var(--bad)]" : "text-[var(--text-dim)]"}>{Math.round(p.stamina * 100)}%</td>
                        <td>
                          <div className="flex items-center gap-1">
                            <button className="btn !px-1 !py-0 text-[11px]" onClick={() => setMinute(p.id, (minutes[p.id] ?? 0) - 2)}>
                              −
                            </button>
                            <input type="number" className="input !py-0.5 !px-1 w-12 text-center text-[12px]" value={minutes[p.id] ?? 0} min={0} max={44} onChange={(e) => setMinute(p.id, Number(e.target.value))} disabled={hurt} />
                            <button className="btn !px-1 !py-0 text-[11px]" onClick={() => setMinute(p.id, (minutes[p.id] ?? 0) + 2)} disabled={hurt}>
                              +
                            </button>
                          </div>
                        </td>
                        <td>{hurt ? <span className="text-[var(--bad)]">伤停{p.injury ? ` ${p.injury.weeksRemaining.toFixed(0)} 周` : ""}</span> : <span className="text-[var(--good)]">健康</span>}</td>
                        <td>
                          <div className="flex items-center gap-1">
                            <button className="btn !py-0.5 !px-1.5 text-[11px]" disabled={hurt} title={hurt ? "伤停球员不能首发" : "提上首发：再点击一个首发位置"} onClick={() => setPromoting(promoting?.id === p.id ? null : p)}>
                              {promoting?.id === p.id ? "取消" : "↑首发"}
                            </button>
                            <button className="btn !py-0.5 !px-1.5 text-[11px] !text-[var(--bad)]" title="裁掉：剩余合同变为死钱仍占工资帽" onClick={() => waive(p)}>
                              裁掉
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      {/* 位置深度图（所有球队可见；其他球队只读） */}
      <Section title={isUserTeam ? "位置深度 — 每列按轮换顺序排列" : `阵容（${players.length} 人）— 引擎自动轮换 · 只读浏览`}>
        {!isUserTeam && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
            {LINEUP_POSITIONS.map((pos, i) => {
              const p = autoSlots[i];
              const fit = p ? positionFit(p, pos) : -1;
              return (
                <div key={pos} className="panel-2 p-2.5">
                  <div className="text-[15px] font-black" style={{ color: POS_COLORS[pos] }}>
                    {pos}
                  </div>
                  {p ? (
                    <>
                      <button className="text-[13px] font-semibold mt-0.5 leading-tight text-left hover:text-[var(--accent)]" onClick={() => setSelected(p)}>
                        {p.name}
                      </button>
                      <div className="text-[11px] text-[var(--text-dim)] mt-0.5">
                        <PosLabel p={p} /> · <span className="text-[var(--accent)] font-bold">{p.ratings.overall}</span>
                        {fit === 1 && <span className="text-[var(--warn)]"> · 客串</span>}
                        {fit === 0 && <span className="text-[var(--bad)]"> · 错位</span>}
                      </div>
                    </>
                  ) : (
                    <div className="text-[12px] text-[var(--text-dim)] mt-1">—</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <DepthChart players={players} slots={isUserTeam ? slots : autoSlots} minutes={minutes} onSelect={setSelected} />
      </Section>

      {/* 其他球队：只读名单表 */}
      {!isUserTeam && (
        <Section title="名单明细">
          <div className="scrollbox">
            <table className="data">
              <thead>
                <tr>
                  <th>球员</th>
                  <th>可打位置</th>
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
                      <td>
                        <PosLabel p={p} />
                      </td>
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

/** 主/副位置徽标：主位置彩色加粗，副位置灰显（2K 的 "SG/SF" 式标注）。 */
function PosLabel({ p, dim }: { p: Player; dim?: boolean }) {
  const main = POS_COLORS[p.position] ?? "#94a3b8";
  return (
    <span className="whitespace-nowrap">
      <span className="font-semibold" style={{ color: main }}>
        {p.position}
      </span>
      {p.secondPosition && <span className={`${dim ? "text-[var(--text-dim)]" : "text-[var(--text-dim)]"} font-normal`}>/{p.secondPosition}</span>}
    </span>
  );
}

/** 位置深度图：每列列出可打该位置的球员，首发置顶 ★，其余按分钟降序。 */
function DepthChart({ players, slots, minutes, onSelect }: { players: Player[]; slots: (Player | null)[]; minutes: Record<string, number>; onSelect: (p: Player) => void }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
      {LINEUP_POSITIONS.map((pos, i) => {
        const starter = slots[i];
        const eligible = players
          .filter((p) => positionFit(p, pos) > 0)
          .sort((a, b) => (a.id === starter?.id ? -1 : b.id === starter?.id ? 1 : (minutes[b.id] ?? 0) - (minutes[a.id] ?? 0) || b.ratings.overall - a.ratings.overall));
        return (
          <div key={pos} className="panel-2 p-2">
            <div className="text-[12px] font-black mb-1.5" style={{ color: POS_COLORS[pos] }}>
              {pos}
            </div>
            <div className="space-y-0.5">
              {eligible.slice(0, 6).map((p) => {
                const isStart = starter?.id === p.id;
                const hurt = !isHealthy(p);
                return (
                  <button key={p.id} className={`w-full text-left px-1.5 py-1 rounded text-[11.5px] flex items-center gap-1 hover:bg-[var(--bg-panel)] ${hurt ? "opacity-55" : ""}`} onClick={() => onSelect(p)}>
                    {isStart && <span className="text-[var(--warn)]">★</span>}
                    <span className={`truncate flex-1 ${isStart ? "font-semibold" : ""}`}>{p.name}</span>
                    <span className="text-[var(--text-dim)] tabular-nums">{p.ratings.overall}</span>
                    <span className="text-[var(--text-dim)] tabular-nums w-8 text-right">{minutes[p.id] ?? 0}′</span>
                  </button>
                );
              })}
              {eligible.length === 0 && <div className="text-[11px] text-[var(--bad)] px-1.5 py-1">无人可打</div>}
              {eligible.length > 6 && <div className="text-[10.5px] text-[var(--text-dim)] px-1.5">+{eligible.length - 6} 人</div>}
            </div>
          </div>
        );
      })}
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
                {positionLabel(p)} · {p.age}岁 · {p.heightCm}cm / {p.weightKg}kg
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
