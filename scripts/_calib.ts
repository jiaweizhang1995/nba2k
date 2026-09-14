/** Sim calibration harness: create a throwaway save, sim N games for one team
 *  vs rotating opponents, print per-game averages next to real baseline stats.
 *
 *  Usage: tsx scripts/_calib.ts [teamAbbr] [games] [seed]
 */
import { createSave, loadLeagueState, deleteSave } from "../src/server/engine";
import { simulateGame, type SimTeam, type SimPlayer } from "../src/domain/sim/game";
import type { LeagueState } from "../src/domain/sim/season";

function toSimTeam(state: LeagueState, teamId: string): SimTeam {
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
        secondPosition: p.secondPosition as SimPlayer["position"],
        ratings: {
          overall: p.ratings.overall,
          inside: p.ratings.inside,
          finishing: p.ratings.finishing,
          threePoint: p.ratings.threePoint,
          freeThrow: p.ratings.freeThrow,
          playmaking: p.ratings.playmaking,
          rebounding: p.ratings.rebounding,
          perimeterD: p.ratings.perimeterD,
          interiorD: p.ratings.interiorD,
        },
        usageTendency: p.ratings.usageTendency,
        role: p.role,
        injury: p.injury && p.injury.weeksRemaining > 0 ? { weeksRemaining: p.injury.weeksRemaining, severity: p.injury.severity } : null,
        stamina: p.stamina,
        morale: p.satisfaction,
      })),
  };
}

async function main() {
  const teamAbbr = (process.argv[2] ?? "PHI").toUpperCase();
  const games = Number(process.argv[3] ?? 48);
  const seed = Number(process.argv[4] ?? 777);

  const s = await createSave({ name: `calib-${teamAbbr}`, teamId: teamAbbr, seed });
  const state = loadLeagueState(s.saveId);
  const target = state.teams.find((t) => t.abbr === teamAbbr)!;
  const others = state.teams.filter((t) => t.id !== target.id);

  const agg = new Map<string, { name: string; g: number; mp: number; pts: number; reb: number; ast: number; stl: number; blk: number; tov: number; fgm: number; fga: number; tpm: number; tpa: number; ftm: number; fta: number }>();
  let teamPts = 0, oppPts = 0, played = 0;
  for (let i = 0; i < games; i++) {
    const opp = others[i % others.length];
    const homeIsTarget = i % 2 === 0;
    const home = toSimTeam(state, homeIsTarget ? target.id : opp.id);
    const away = toSimTeam(state, homeIsTarget ? opp.id : target.id);
    const r = simulateGame(home, away, { seed: seed + i * 31, salt: `cal${i}` });
    const myBox = homeIsTarget ? r.box.home : r.box.away;
    teamPts += homeIsTarget ? r.homeScore : r.awayScore;
    oppPts += homeIsTarget ? r.awayScore : r.homeScore;
    played++;
    for (const l of myBox) {
      let a = agg.get(l.playerId);
      if (!a) {
        a = { name: l.name, g: 0, mp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 };
        agg.set(l.playerId, a);
      }
      a.g++; a.mp += l.mp; a.pts += l.pts; a.reb += l.reb; a.ast += l.ast; a.stl += l.stl; a.blk += l.blk; a.tov += l.tov;
      a.fgm += l.fgm; a.fga += l.fga; a.tpm += l.tpm; a.tpa += l.tpa; a.ftm += l.ftm; a.fta += l.fta;
    }
  }

  const rows = [...agg.values()].sort((a, b) => b.mp / b.g - a.mp / a.g);
  const pct = (m: number, a: number) => (a > 0 ? ((m / a) * 100).toFixed(1) : "-");
  console.log(`\n=== ${teamAbbr} 模拟 ${played} 场 | 场均得分 ${(teamPts / played).toFixed(1)} : ${(oppPts / played).toFixed(1)} ===`);
  console.log("球员".padEnd(26), "分钟", "得分", "篮板", "助攻", "抢断", "盖帽", "失误", "FG%", "3P%", "FT%");
  for (const a of rows) {
    if (a.mp / a.g < 2) continue;
    console.log(
      a.name.padEnd(28),
      (a.mp / a.g).toFixed(1).padStart(5),
      (a.pts / a.g).toFixed(1).padStart(6),
      (a.reb / a.g).toFixed(1).padStart(6),
      (a.ast / a.g).toFixed(1).padStart(6),
      (a.stl / a.g).toFixed(1).padStart(6),
      (a.blk / a.g).toFixed(1).padStart(6),
      (a.tov / a.g).toFixed(1).padStart(6),
      pct(a.fgm, a.fga).padStart(6),
      pct(a.tpm, a.tpa).padStart(6),
      pct(a.ftm, a.fta).padStart(6),
    );
  }
  deleteSave(s.saveId); // throwaway calibration save — don't leave litter
}

main().catch((e) => { console.error("ERR:", e); process.exit(1); });
