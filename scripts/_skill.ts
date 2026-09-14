import { createSave, loadLeagueState, deleteSave } from "../src/server/engine";
import { buildRotation, type SimTeam, type SimPlayer } from "../src/domain/sim/game";
import { rngFor } from "../src/domain/rng";
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
  const s = await createSave({ name: "skill", teamId: "PHI", seed: 1 });
  const state = loadLeagueState(s.saveId);
  const rng = rngFor(1, "x");
  const rows = state.teams.map((t) => {
    const team = toSimTeam(state, t.id);
    const slots = buildRotation(team, rng, {});
    const skill = (side: "off" | "def") => {
      let num = 0, den = 0;
      for (const sl of slots) {
        const r = sl.player.ratings;
        const v = side === "off" ? (r.inside + r.finishing + r.threePoint + r.playmaking) / 4 : (r.perimeterD + r.interiorD + r.rebounding) / 3;
        num += v * sl.plan; den += sl.plan;
      }
      return num / den;
    };
    let on = 0, dn = 0;
    for (const sl of slots) { on += sl.player.ratings.overall * sl.plan; dn += sl.plan; }
    const ov = team.players.map((p) => p.ratings.overall).sort((a, b) => b - a);
    return { abbr: t.abbr, off: skill("off"), def: skill("def"), ovr: on / dn, top3: ov.slice(0, 3).reduce((a, b) => a + b) / 3 };
  });
  rows.sort((a, b) => (b.off + b.def + b.ovr * 1.4) - (a.off + a.def + a.ovr * 1.4));
  console.log("队   off    def    ovrW   top3OVR");
  for (const r of rows) console.log(`${r.abbr}  ${r.off.toFixed(1)}  ${r.def.toFixed(1)}   ${r.ovr.toFixed(1)}   ${r.top3.toFixed(1)}`);
  deleteSave(s.saveId);
}
main().catch((e) => { console.error(e); process.exit(1); });
