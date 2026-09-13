// Possession-based single game simulation.
// Deterministic given (seed, salt). Produces box scores, team totals and
// human-readable "why" notes.

import { rngFor, PRNG } from "../rng";
import type { BoxPlayerLine, BoxScoreJson, Position } from "../types";

export const GAME_SIM_VERSION = "GAME-SIM v1.0";

export interface SimPlayer {
  id: string;
  name: string;
  position: Position;
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
  };
  usageTendency: number;
  role: string;
  injury: { weeksRemaining: number; severity: string } | null;
  stamina: number; // 0-1, 1 = fresh
}

export interface SimTeam {
  id: string;
  name: string;
  players: SimPlayer[];
}

interface RotationSlot {
  player: SimPlayer;
  minutes: number;
}

const MIN = 48 * 5; // 240 player-minutes per team per game

/** Minutes allocation by role/overall with fatigue; sorted by minutes desc. */
export function buildRotation(team: SimTeam, rng: PRNG, backToBack: boolean): RotationSlot[] {
  const avail = team.players.filter((p) => !p.injury || p.injury.weeksRemaining <= 0);
  if (avail.length < 5) return [];
  const weight = (p: SimPlayer) => {
    const roleBoost =
      p.role === "STAR" ? 1.9 : p.role === "STARTER" ? 1.5 : p.role === "SIXTH_MAN" ? 1.15 : p.role === "ROTATION" ? 0.9 : 0.45;
    return Math.pow(Math.max(20, p.ratings.overall) / 50, 2.2) * roleBoost * (0.7 + 0.3 * p.stamina);
  };
  const fatigue = backToBack ? 0.92 : 1;
  const raw = avail.map((p) => ({ p, w: weight(p) * fatigue }));
  const totalW = raw.reduce((a, r) => a + r.w, 0);
  const slots: RotationSlot[] = raw.map((r) => ({ player: r.p, minutes: (r.w / totalW) * MIN }));
  slots.sort((a, b) => b.minutes - a.minutes);
  for (let i = 0; i < 5; i++) slots[i].minutes = Math.max(slots[i].minutes, 30 + rng.float(-2, 2));
  let sum = slots.reduce((a, s) => a + s.minutes, 0);
  for (const s of slots) s.minutes = Math.max(2, (s.minutes / sum) * MIN);
  sum = slots.reduce((a, s) => a + s.minutes, 0);
  for (const s of slots) s.minutes = (s.minutes / sum) * MIN;
  return slots.map((s) => ({ player: s.player, minutes: Math.round(s.minutes * 10) / 10 }));
}

export interface GameSimResult {
  homeScore: number;
  awayScore: number;
  box: BoxScoreJson;
  notes: string[];
}

function emptyLine(p: SimPlayer): BoxPlayerLine {
  return {
    playerId: p.id,
    name: p.name,
    teamId: "",
    mp: 0,
    pts: 0,
    reb: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    tov: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
  };
}

function efg(fgm: number, tpm: number, fga: number): number {
  return fga > 0 ? (fgm + 0.5 * tpm) / fga : 0;
}

export function simulateGame(
  home: SimTeam,
  away: SimTeam,
  opts: { seed: number | string; salt: string; neutral?: boolean; backToBackHome?: boolean; backToBackAway?: boolean; playoff?: boolean },
): GameSimResult {
  const rng = rngFor(opts.seed, opts.salt);
  const homeRot = buildRotation(home, rng, !!opts.backToBackHome);
  const awayRot = buildRotation(away, rng, !!opts.backToBackAway);
  if (homeRot.length < 5 || awayRot.length < 5) {
    const homeShort = homeRot.length < 5;
    const note = `${homeShort ? home.name : away.name} 可用球员不足 5 人，比赛按规则判定`;
    return {
      homeScore: homeShort ? 80 : 100,
      awayScore: homeShort ? 100 : 80,
      box: { home: [], away: [], homeTotals: { pts: 0, reb: 0, ast: 0 }, awayTotals: { pts: 0, reb: 0, ast: 0 }, notes: [note] },
      notes: [note],
    };
  }

  const lines = new Map<string, BoxPlayerLine>();
  const lineOf = (p: SimPlayer) => {
    let l = lines.get(p.id);
    if (!l) {
      l = emptyLine(p);
      lines.set(p.id, l);
    }
    return l;
  };
  for (const s of homeRot) lineOf(s.player).teamId = home.id;
  for (const s of awayRot) lineOf(s.player).teamId = away.id;
  for (const s of [...homeRot, ...awayRot]) lineOf(s.player).mp = s.minutes;

  const teamStrength = (rot: RotationSlot[], side: "off" | "def") => {
    let num = 0;
    let den = 0;
    for (const s of rot) {
      const r = s.player.ratings;
      const v = side === "off" ? (r.finishing + r.threePoint + r.playmaking) / 3 : (r.perimeterD + r.interiorD + r.rebounding) / 3;
      num += v * s.minutes;
      den += s.minutes;
    }
    return num / Math.max(1, den);
  };

  const homeOff = teamStrength(homeRot, "off");
  const homeDef = teamStrength(homeRot, "def");
  const awayOff = teamStrength(awayRot, "off");
  const awayDef = teamStrength(awayRot, "def");

  // pace calibrated to real NBA team scoring (2025-26 baseline ≈ 116/team)
  const pace = 107 + rng.float(-4, 4) + ((homeOff + awayOff - (homeDef + awayDef)) / 2 - 55) * 0.12;
  // pace is per-team possessions (NBA-like ~100 per 48 minutes)
  const possessionsPerTeam = Math.round(pace + rng.float(-3, 3));

  // Player sampling weights: minutes-weighted, tilted slightly by overall.
  const pickFrom = (rot: RotationSlot[], bias = 0) => {
    const players = rot.filter((s) => s.minutes >= 2).map((s) => s.player);
    return rng.weighted(players, (p) => (Math.max(20, p.ratings.overall) / 50) ** 2.4 + bias + p.usageTendency * 7);
  };

  const rebPlayers = (rot: RotationSlot[]) => rot.filter((s) => s.minutes >= 2).map((s) => s.player);

  /** Simulate one team's possessions on offense. */
  const attack = (offRot: RotationSlot[], defRating: number, oppRot: RotationSlot[], isHome: boolean) => {
    for (let i = 0; i < possessionsPerTeam; i++) {
      const scorer = pickFrom(offRot);
      const line = lineOf(scorer);
      const r = scorer.ratings;

      const tovChance = Math.max(0.06, 0.13 + (65 - r.playmaking) * 0.0022 + rng.float(-0.02, 0.02));
      if (rng.chance(tovChance)) {
        line.tov++;
        continue;
      }

      const threeProb = Math.max(0.08, Math.min(0.62, (r.threePoint - 40) / 100 + 0.22));
      const isThree = rng.chance(threeProb);
      const shooterSkill = isThree ? r.threePoint : (r.finishing + r.inside) / 2;
      let makeP = 0.54 + (shooterSkill - defRating) * 0.0075;
      if (isThree) makeP -= 0.17;
      makeP = Math.max(0.2, Math.min(0.72, makeP + rng.gauss(0, 0.03)));

      line.fga++;
      if (isThree) line.tpa++;

      if (rng.chance(makeP)) {
        line.fgm++;
        line.pts += isThree ? 3 : 2;
        if (isThree) line.tpm++;
        const helper = pickFrom(offRot);
        if (helper.id !== scorer.id && rng.chance(0.08 + helper.ratings.playmaking * 0.0035)) {
          lineOf(helper).ast++;
        }
      } else if (rng.chance(0.3)) {
        line.fta += 2;
        const ft1 = rng.chance(r.freeThrow / 100) ? 1 : 0;
        const ft2 = rng.chance(r.freeThrow / 100) ? 1 : 0;
        line.ftm += ft1 + ft2;
        line.pts += ft1 + ft2;
      } else {
        // rebound battle
        const oRebW = offRot.reduce((a, s) => a + s.player.ratings.rebounding * s.minutes, 0);
        const dRebW = oppRot.reduce((a, s) => a + s.player.ratings.rebounding * s.minutes, 0);
        const oRebP = 0.05 + (oRebW / (oRebW + dRebW)) * 0.28;
        const rebber = rng.weighted(rebPlayers(rng.chance(oRebP) ? offRot : oppRot), (p) => p.ratings.rebounding);
        lineOf(rebber).reb++;
      }

      if (rng.chance(0.035)) {
        lineOf(rng.weighted(rebPlayers(oppRot), (p) => p.ratings.interiorD)).blk++;
      }
      if (rng.chance(0.045)) {
        lineOf(rng.weighted(rebPlayers(oppRot), (p) => p.ratings.perimeterD)).stl++;
      }
      void isHome;
    }
  };

  attack(homeRot, awayDef, awayRot, true);
  attack(awayRot, homeDef, homeRot, false);

  // Home court advantage: +2~3 pts added as a made corner three / FT noise.
  if (!opts.neutral) {
    const hcaHero = pickFrom(homeRot);
    const hl = lineOf(hcaHero);
    hl.tpa++;
    hl.tpm++;
    hl.fga++;
    hl.fgm++;
    hl.pts += 3;
    if (rng.chance(0.4)) {
      const villain = pickFrom(awayRot);
      const vl = lineOf(villain);
      vl.fta++;
      if (rng.chance(villain.ratings.freeThrow / 100 + 0.15)) {
        vl.ftm++;
        vl.pts += 1;
      }
    }
  }

  let homeScore = [...lines.values()].filter((l) => l.teamId === home.id).reduce((a, l) => a + l.pts, 0);
  const awayScore = [...lines.values()].filter((l) => l.teamId === away.id).reduce((a, l) => a + l.pts, 0);

  if (opts.playoff && homeScore === awayScore) {
    const hero = pickFrom(homeRot, 0.5);
    const l = lineOf(hero);
    l.fta++;
    l.ftm++;
    l.pts += 1;
    homeScore = [...lines.values()].filter((x) => x.teamId === home.id).reduce((a, x) => a + x.pts, 0);
  }

  const boxLines = [...lines.values()].filter((l) => l.teamId !== "");
  boxLines.sort((a, b) => b.mp - a.mp);
  const homeLines = boxLines.filter((l) => l.teamId === home.id);
  const awayLines = boxLines.filter((l) => l.teamId === away.id);
  const sum = (arr: BoxPlayerLine[], k: keyof BoxPlayerLine) => arr.reduce((a, l) => a + (l[k] as number), 0);

  // "Why" notes
  const notes: string[] = [];
  const top = (arr: BoxPlayerLine[]) => [...arr].sort((a, b) => b.pts - a.pts)[0];
  if (top(homeLines)) notes.push(`${home.name} 队内得分王：${top(homeLines)!.name} ${top(homeLines)!.pts} 分`);
  if (top(awayLines)) notes.push(`${away.name} 队内得分王：${top(awayLines)!.name} ${top(awayLines)!.pts} 分`);
  notes.push(
    `有效命中率 ${home.name} ${(efg(sum(homeLines, "fgm"), sum(homeLines, "tpm"), sum(homeLines, "fga")) * 100).toFixed(1)}% vs ${away.name} ${(
      efg(sum(awayLines, "fgm"), sum(awayLines, "tpm"), sum(awayLines, "fga")) * 100
    ).toFixed(1)}%`,
  );
  const rebH = sum(homeLines, "reb");
  const rebA = sum(awayLines, "reb");
  if (Math.abs(rebH - rebA) >= 6) notes.push(`篮板差距明显：${home.name} ${rebH} vs ${away.name} ${rebA}`);
  const tovH = sum(homeLines, "tov");
  const tovA = sum(awayLines, "tov");
  if (Math.abs(tovH - tovA) >= 5) notes.push(`失误差距影响节奏：${home.name} ${tovH} 次 vs ${away.name} ${tovA} 次`);
  if (Math.abs(awayOff - homeOff) > 8) notes.push(`阵容进攻质量差距（${homeOff.toFixed(0)} vs ${awayOff.toFixed(0)}）放大了得分效率差异`);

  return {
    homeScore,
    awayScore,
    box: {
      home: homeLines,
      away: awayLines,
      homeTotals: { pts: homeScore, reb: rebH, ast: sum(homeLines, "ast") },
      awayTotals: { pts: awayScore, reb: rebA, ast: sum(awayLines, "ast") },
      notes,
    },
    notes,
  };
}
