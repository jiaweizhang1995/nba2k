// Calibrate star minutes & scoring: sim N games across random team pairs on a
// fresh demo save, then report the league's top scorers (ppg/mpg) and minutes.
import { createSave, loadLeagueState } from "../src/server/engine";
import { simulateGame, type SimTeam, type SimPlayer } from "../src/domain/sim/game";
import type { LeagueState } from "../src/domain/sim/season";

const toSimTeam = (state: LeagueState, teamId: string): SimTeam => {
  const t = state.teams.find((x) => x.id === teamId)!;
  return {
    id: t.id,
    name: t.abbr,
    players: state.players
      .filter((p) => p.teamId === teamId && (p.status === "ACTIVE" || p.status === "INJURED"))
      .map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position as SimPlayer["position"],
        ratings: p.ratings as never,
        usageTendency: p.ratings.usageTendency,
        role: p.role,
        injury: p.injury && p.injury.weeksRemaining > 0 ? { weeksRemaining: p.injury.weeksRemaining, severity: p.injury.severity } : null,
        stamina: p.stamina,
      })),
  };
};

const main = async () => {
  const GAMES = Number(process.argv[2] ?? 240);
  const s = await createSave({ name: `calib-${Date.now()}`, seed: 20260913 });
  const st = loadLeagueState(s.saveId);
  const teams = st.teams.map((t) => toSimTeam(st, t.id));

  const agg = new Map<string, { name: string; ovr: number; pts: number; mp: number; g: number }>();
  let totalPts = 0;
  for (let i = 0; i < GAMES; i++) {
    const h = teams[i % teams.length];
    const a = teams[(i * 7 + 3) % teams.length];
    if (h.id === a.id) continue;
    const r = simulateGame(h, a, { seed: 1000 + i, salt: "cal" });
    totalPts += r.homeScore + r.awayScore;
    for (const l of [...r.box.home, ...r.box.away]) {
      const p = [...h.players, ...a.players].find((x) => x.id === l.playerId);
      if (!p) continue;
      const e = agg.get(l.playerId) ?? { name: l.name, ovr: p.ratings.overall, pts: 0, mp: 0, g: 0 };
      e.pts += l.pts;
      e.mp += l.mp;
      e.g += 1;
      agg.set(l.playerId, e);
    }
  }
  console.log(`avg total/game: ${(totalPts / (GAMES * 2)).toFixed(1)} (per team)`);
  const rows = [...agg.values()].filter((e) => e.g >= 3).map((e) => ({ ...e, ppg: e.pts / e.g, mpg: e.mp / e.g }));
  rows.sort((a, b) => b.ppg - a.ppg);
  console.log("--- top 20 scorers ---");
  for (const r of rows.slice(0, 20)) {
    console.log(`${r.name.padEnd(24)} ovr ${String(r.ovr).padStart(3)}  ${r.ppg.toFixed(1)} ppg  ${r.mpg.toFixed(1)} mpg  (${r.g}g)`);
  }
  console.log("--- minutes leaders ---");
  [...rows].sort((a, b) => b.mpg - a.mpg).slice(0, 15).forEach((r) => {
    console.log(`${r.name.padEnd(24)} ovr ${String(r.ovr).padStart(3)}  ${r.mpg.toFixed(1)} mpg  ${r.ppg.toFixed(1)} ppg`);
  });
};
main();
