import { createSave, loadLeagueState } from "../src/server/engine";
import { simulateGame, type SimTeam, type SimPlayer } from "../src/domain/sim/game";
import type { LeagueState } from "../src/domain/sim/season";

const toSimTeam = (state: LeagueState, teamId: string): SimTeam => {
  const t = state.teams.find((x) => x.id === teamId)!;
  return {
    id: t.id, name: t.abbr,
    players: state.players.filter((p) => p.teamId === teamId && (p.status === "ACTIVE" || p.status === "INJURED")).map((p) => ({
      id: p.id, name: p.name, position: p.position as SimPlayer["position"],
      ratings: p.ratings as never, usageTendency: p.ratings.usageTendency, role: p.role,
      injury: p.injury && p.injury.weeksRemaining > 0 ? { weeksRemaining: p.injury.weeksRemaining, severity: p.injury.severity } : null,
      stamina: p.stamina,
    })),
  };
};

const main = async () => {
  const s = await createSave({ name: "dbg", seed: 20260913 });
  const st = loadLeagueState(s.saveId);
  const teamId = st.teams[0].id;
  const roster = st.players.filter((p) => p.teamId === teamId && (p.status === "ACTIVE" || p.status === "INJURED"));
  const byOvr = [...roster].sort((a, b) => b.ratings.overall - a.ratings.overall);
  const starters = byOvr.slice(4, 9).map((p) => p.id);
  const team = toSimTeam(st, teamId);
  team.config = { starters, minutes: Object.fromEntries(starters.map((id) => [id, 36])) };
  const away = toSimTeam(st, st.teams[1].id);
  const game = simulateGame(team, away, { seed: 77, salt: "rotcfg" });
  for (const l of game.box.home) {
    console.log(l.name.padEnd(22), "mp:", String(l.mp).padStart(5), "fouls? pts:", l.pts);
  }
};
main();
