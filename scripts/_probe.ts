/** Head-to-head probe: every team plays every other team N times (neutral),
 *  report win% vs roster strength — measures the skill→win conversion slope.
 *  Usage: tsx scripts/_probe.ts [gamesPerPair] [seed]
 */
import { createSave, loadLeagueState, deleteSave } from "../src/server/engine";
import { simulateGame, type SimTeam, type SimPlayer } from "../src/domain/sim/game";
import type { LeagueState } from "../src/domain/sim/season";

function toSimTeam(state: LeagueState, teamId: string): SimTeam {
  const t = state.teams.find((x) => x.id === teamId)!;
  return {
    id: t.id, name: t.abbr,
    players: state.players
      .filter((p) => p.teamId === teamId && (p.status === "ACTIVE" || p.status === "INJURED"))
      .map((p) => ({
        id: p.id, name: p.name,
        position: p.position as SimPlayer["position"],
        secondPosition: p.secondPosition as SimPlayer["position"],
        ratings: { ...p.ratings },
        usageTendency: p.ratings.usageTendency, role: p.role,
        injury: null, stamina: 1, morale: 65,
      })),
  };
}

async function main() {
  const N = Number(process.argv[2] ?? 6);
  const seed = Number(process.argv[3] ?? 42);
  const s = await createSave({ name: "probe", teamId: "PHI", seed });
  const state = loadLeagueState(s.saveId);
  const teams = state.teams.map((t) => t.abbr);
  const sim = new Map(teams.map((a) => [a, toSimTeam(state, state.teams.find((t) => t.abbr === a)!.id)]));
  const ovr = (a: string) => {
    const ps = (sim.get(a)!.players as any[]).sort((x, y) => y.ratings.overall - x.ratings.overall);
    return { top3: ps.slice(0, 3).reduce((s2, p) => s2 + p.ratings.overall, 0) / 3, top8: ps.slice(0, 8).reduce((s2, p) => s2 + p.ratings.overall, 0) / 8 };
  };
  const wins = new Map(teams.map((a) => [a, 0]));
  const games = new Map(teams.map((a) => [a, 0]));
  for (let i = 0; i < teams.length; i++)
    for (let j = i + 1; j < teams.length; j++)
      for (let k = 0; k < N; k++) {
        const home = k % 2 === 0 ? teams[i] : teams[j];
        const away = k % 2 === 0 ? teams[j] : teams[i];
        const r = simulateGame(sim.get(home)!, sim.get(away)!, { seed: seed + i * 977 + j * 131 + k * 17, salt: `p${i}${j}${k}` });
        const w = r.homeScore > r.awayScore ? home : away;
        wins.set(w, wins.get(w)! + 1);
        games.set(teams[i], games.get(teams[i])! + 1);
        games.set(teams[j], games.get(teams[j])! + 1);
      }
  const rows = teams.map((a) => ({ a, w: wins.get(a)!, g: games.get(a)!, ...ovr(a) }))
    .map((r) => ({ ...r, wpct: r.w / r.g })).sort((x, y) => y.wpct - x.wpct);
  const corr = (key: "top3" | "top8") => {
    const xs = rows.map((r) => r[key]), ys = rows.map((r) => r.wpct);
    const mx = xs.reduce((a2, b) => a2 + b) / xs.length, my = ys.reduce((a2, b) => a2 + b) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    return (num / Math.sqrt(dx * dy)).toFixed(3);
  };
  console.log(`N=${N}/pair | corr top3=${corr("top3")} top8=${corr("top8")}`);
  for (const r of rows) console.log(`${r.a}  ${(r.wpct * 100).toFixed(0)}%  (${r.w}-${r.g - r.w})  top3=${r.top3.toFixed(1)} top8=${r.top8.toFixed(1)}`);
  deleteSave(s.saveId);
}
main().catch((e) => { console.error("ERR:", e); process.exit(1); });
