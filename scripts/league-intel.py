#!/usr/bin/env python3
"""League-wide intel dump for the AGENT eval — mirrors domain/trade.ts valuation.
Read-only sqlite inspection; saves get_market turns. Usage: league-intel.py [saveId] [teamAbbr]"""
import json, sqlite3, sys, math

DB = "data/nba2k-gm.db"
SEASON = 2027
CAP, TAX, APRON1, APRON2, MIN_SAL = 140.0, 170.0, 178.0, 188.0, 126.0

def age_mult(a):
    if a <= 21: return 1.08
    if a <= 24: return 1.12
    if a <= 27: return 1.05
    if a <= 30: return 0.92
    if a <= 33: return 0.72
    return 0.5

def sal0(contract):
    ys = contract.get("years") or []
    return ys[0]["salary"] if ys else 0.0

def end_season(contract):
    ys = contract.get("years") or []
    return ys[-1]["season"] if ys else 0

def pvalue(p, season=SEASON):
    r = p["ovr"]
    base = max(0, r - 58) ** 1.55
    v = base * 0.9
    pot = p.get("pot")
    if pot is not None and p["age"] <= 24:
        v += max(0, pot - r) * 2.4
    v *= age_mult(p["age"])
    salary = p["sal0"]
    ppm = (r - 65) / salary if salary > 0 else 2
    if ppm < 0.15: v *= 0.85
    elif ppm > 0.8: v *= 1.12
    if end_season(p["contract"]) - season <= 0: v *= 0.8  # expiring
    if p["contract"].get("noTrade"): v *= 0.7
    if (p.get("sat") or 70) < 35: v *= 0.8
    return v

def need_premium(team_players, phase, p):
    is_star = p.get("role") == "STAR" or p["ovr"] >= 84
    if not is_star and p["ovr"] < 74: return 0.0
    prem = 0.0
    if is_star:
        prem += {"CONTENDER": 0.9, "PLAYOFF": 0.7, "BUBBLE": 0.45}.get(phase, 0.25)
    at_pos = [x for x in team_players if x["pos"] == p["pos"]]
    best = max([x["ovr"] for x in at_pos], default=0)
    if len(at_pos) <= 2: prem += 0.1
    if p["ovr"] > best + 5: prem += 0.15
    elif p["ovr"] > best: prem += 0.06
    return min(1.0 if is_star else 0.25, prem)

def main():
    save_id, only = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    teams = con.execute("SELECT * FROM teams WHERE save_id=?", (save_id,)).fetchall()
    picks = con.execute("SELECT * FROM draft_picks WHERE save_id=? AND status='OWNED'", (save_id,)).fetchall()
    players = con.execute("SELECT * FROM players WHERE save_id=? AND status='ACTIVE' AND team_id IS NOT NULL", (save_id,)).fetchall()
    by_team = {}
    for p in players:
        c = json.loads(p["contract"]); rt = json.loads(p["ratings"])
        rec = {"id": p["id"].split(":", 1)[1], "name": p["name"], "pos": p["position"], "age": p["age"],
               "ovr": rt["overall"], "pot": rt.get("potential"), "sal0": sal0(c), "end": end_season(c),
               "sat": p["satisfaction"], "role": p["role"], "contract": c, "opt": c.get("option"),
               "noTrade": c.get("noTrade", False)}
        by_team.setdefault(p["team_id"].split(":")[1], []).append(rec)
    pick_by_team = {}
    for pk in picks:
        prot = json.loads(pk["protection"]) if pk["protection"] else None
        pick_by_team.setdefault(pk["holder_team_id"].split(":")[1], []).append(
            {"id": pk["id"].split(":", 1)[1], "yr": pk["year"], "rd": pk["round"],
             "orig": pk["original_team_id"].split(":")[1], "prot": prot})

    rows = []
    for t in teams:
        ab = t["abbr"]
        if only and ab != only: continue
        ps = by_team.get(ab, [])
        tot = sum(x["sal0"] for x in ps)
        status = "2AP" if tot > APRON2 else "1AP" if tot > APRON1 else "TAX" if tot > TAX else "OVR" if tot > CAP else "SPACE"
        f1 = sorted([k for k in pick_by_team.get(ab, []) if k["rd"] == 1 and k["orig"] == ab], key=lambda k: k["yr"])
        rows.append((ab, t["ai_phase"], t["ai_risk"], t["wins"], t["losses"], tot, status, len(ps), len(f1)))
        if only:
            print(f"\n=== {ab} {t['ai_phase']} risk={t['ai_risk']:.2f} {t['wins']}-{t['losses']} sal={tot:.1f} {status} n={len(ps)} ownF1={[k['yr'] for k in f1]}")
            for x in sorted(ps, key=lambda x: -pvalue(x)):
                exp = "EXP" if x["end"] <= SEASON else f"{x['end']}"
                print(f"  {x['name']:<26} {x['pos']:<3} {x['age']} ovr={x['ovr']} ${x['sal0']:>6.2f}->{exp} v={pvalue(x):6.1f} sat={x['sat']:.0f} {x['role']} {x['id']}")
            pk = pick_by_team.get(ab, [])
            print("  picks:", ", ".join(f"{k['yr']}r{k['rd']}{'P' if k['prot'] else ''}{'('+k['orig']+')' if k['orig']!=ab else ''}" for k in sorted(pk, key=lambda k:(k['yr'],k['rd']))))
    if not only:
        print(f"{'TM':<4}{'phase':<11}{'risk':<5}{'W-L':<7}{'sal':<7}{'cap':<6}{'n':<3}ownF1")
        for r in sorted(rows, key=lambda r: r[0]):
            print(f"{r[0]:<4}{r[1]:<11}{r[2]:<5.2f}{r[3]}-{r[4]:<5}{r[5]:<7.1f}{r[6]:<6}{r[7]:<3}{r[8]}")
    # CHA vets: who wants them?
    cha = by_team.get("CHA", [])
    if not only:
        print("\n=== CHA sell candidates — best needPremium buyers ===")
        vets = [x for x in cha if x["age"] >= 26 or x["ovr"] >= 74]
        for v in sorted(vets, key=lambda x: -pvalue(x)):
            scored = []
            for t in teams:
                ab = t["abbr"]
                if ab == "CHA": continue
                prem = need_premium(by_team.get(ab, []), t["ai_phase"], v)
                if prem > 0: scored.append((prem, ab))
            scored.sort(reverse=True)
            print(f"  {v['name']:<24} {v['pos']} ovr={v['ovr']} ${v['sal0']:.1f} v={pvalue(v):5.1f} → {', '.join(f'{a}+{p:.2f}' for p,a in scored[:6])}")

if __name__ == "__main__":
    main()
