"use client";

// League page: standings, stat leaders, awards history.

import { useCallback, useEffect, useState } from "react";
import { api, useSave } from "@/components/save-context";
import { Section, Toast, fmtAvg } from "@/components/ui";

interface TeamRow {
  id: string;
  abbr: string;
  city: string;
  name: string;
  wins: number;
  losses: number;
}
interface Leader {
  id: string;
  name: string;
  teamId: string | null;
  g: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
}
interface LeagueResp {
  east: TeamRow[];
  west: TeamRow[];
  leaders: Leader[];
  awards: { id: string; season: number; type: string; playerId: string | null; teamId: string | null; detail: string | null }[];
}

const AWARD_LABEL: Record<string, string> = { CHAMPION: "总冠军", MVP: "MVP", DPOY: "最佳防守", ROY: "最佳新秀" };

export default function LeaguePage() {
  const { summary, saveId } = useSave();
  const [league, setLeague] = useState<LeagueResp | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const load = useCallback(async () => {
    if (!saveId) return;
    try {
      const j = await api<LeagueResp>(`/api/saves/${saveId}/league`);
      setLeague(j);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  }, [saveId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;
  if (!league) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载联盟数据中…</div>;

  const teamName = (id: string | null) => {
    if (!id) return "—";
    const short = id.split(":").pop();
    const all = [...league.east, ...league.west].find((t) => t.id === short || t.id.endsWith(short ?? "@@@"));
    return all ? `${all.city} ${all.name}` : short ?? "—";
  };

  const standingsTable = (rows: TeamRow[], title: string) => (
    <Section title={title}>
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>球队</th>
            <th>胜</th>
            <th>负</th>
            <th>胜率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={t.id} style={{ background: t.id === summary.userTeam?.id ? "#1d2b4a" : undefined }}>
              <td className="text-[var(--text-dim)]">{i + 1}</td>
              <td className="font-medium">
                {t.city} {t.name}
              </td>
              <td className="text-[var(--good)]">{t.wins}</td>
              <td className="text-[var(--bad)]">{t.losses}</td>
              <td>{t.wins + t.losses > 0 ? ((t.wins / (t.wins + t.losses)) * 100).toFixed(1) : "—"}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      {standingsTable(league.east, "东部排名")}
      {standingsTable(league.west, "西部排名")}

      <Section title="联盟数据榜（场均，≥10 场）">
        <div className="scrollbox max-h-96">
          <table className="data">
            <thead>
              <tr>
                <th>球员</th>
                <th>球队</th>
                <th>得分</th>
                <th>篮板</th>
                <th>助攻</th>
                <th>抢断</th>
                <th>盖帽</th>
              </tr>
            </thead>
            <tbody>
              {league.leaders.slice(0, 15).map((l) => (
                <tr key={l.id}>
                  <td className="font-medium">{l.name}</td>
                  <td className="text-[var(--text-dim)]">{teamName(l.teamId)}</td>
                  <td className="font-semibold text-[var(--accent)]">{fmtAvg(l.ppg)}</td>
                  <td>{fmtAvg(l.rpg)}</td>
                  <td>{fmtAvg(l.apg)}</td>
                  <td>{fmtAvg(l.spg)}</td>
                  <td>{fmtAvg(l.bpg)}</td>
                </tr>
              ))}
              {league.leaders.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-[var(--text-dim)] py-6">
                    赛季尚未开始或样本不足
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-[var(--text-dim)] mt-2">以上统计由模拟引擎计算的比赛累计得出（赛季进行后显示）；导入的真实名单暂无统计样本。</div>
      </Section>

      <Section title="奖项与历史">
        {league.awards.length === 0 ? (
          <div className="text-[12px] text-[var(--text-dim)]">完成第一个赛季后这里会显示总冠军与个人奖项。</div>
        ) : (
          <div className="space-y-1.5 text-[12px]">
            {[...league.awards].sort((a, b) => b.season - a.season).map((a) => (
              <div key={a.id} className="panel-2 px-3 py-2 flex justify-between gap-2">
                <span>
                  <span className="tag mr-2">{a.season - 1}-{String(a.season).slice(2)}</span>
                  <b>{AWARD_LABEL[a.type] ?? a.type}</b>
                </span>
                <span className="text-[var(--text-dim)]">{a.playerId ? a.detail ?? "" : a.detail ?? ""}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
