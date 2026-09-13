"use client";

// GM home: record, standings position, cap, chemistry, upcoming games,
// recent results and an AI/rule-based news feed.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, useSave, PHASE_LABEL } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";
import { CBA } from "@/domain/salary";

interface LeagueResp {
  east: { id: string; abbr: string; city: string; name: string; wins: number; losses: number; conference: string }[];
  west: { id: string; abbr: string; city: string; name: string; wins: number; losses: number; conference: string }[];
  upcoming: { id: string; date: string; homeTeamId: string; awayTeamId: string; homeScore: number | null; awayScore: number | null; status: string }[];
  recent: { id: string; date: string; homeTeamId: string; awayTeamId: string; homeScore: number | null; awayScore: number | null }[];
}
interface TeamInfo {
  id: string;
  abbr: string;
  city: string;
  name: string;
}
interface PlayerLite {
  id: string;
  name: string;
  position: string;
  ratings: { overall: number };
  role: string;
  status: string;
}

export default function GmHome() {
  const { summary, saveId, refresh } = useSave();
  const [league, setLeague] = useState<LeagueResp | null>(null);
  const [teamMap, setTeamMap] = useState<Map<string, TeamInfo>>(new Map());
  const [roster, setRoster] = useState<PlayerLite[]>([]);
  const [news, setNews] = useState<string[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const userTeamId = summary?.userTeam?.id;
  const load = useCallback(async () => {
    if (!saveId) return;
    try {
      const j = await api<LeagueResp>(`/api/saves/${saveId}/league`);
      setLeague(j);
      const all = [...j.east, ...j.west] as TeamInfo[];
      setTeamMap(new Map(all.map((t) => [t.id, t])));
      if (userTeamId) {
        const r = await api<{ players: PlayerLite[] }>(`/api/saves/${saveId}/roster?teamId=${encodeURIComponent(userTeamId)}`);
        setRoster(r.players.filter((p) => p.status === "ACTIVE" || p.status === "INJURED").sort((a, b) => b.ratings.overall - a.ratings.overall));
      }
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
    await refresh();
  }, [saveId, refresh, userTeamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const makeNews = async () => {
    if (!saveId || !summary?.userTeam) return;
    setAiBusy(true);
    try {
      const facts = [
        `${summary.userTeam.city} ${summary.userTeam.name} 目前 ${summary.userTeam.wins} 胜 ${summary.userTeam.losses} 负`,
        `化学反应 ${summary.chemistry?.overall ?? "?"}/100，总薪资 ${summary.cap.totalSalary.toFixed(1)}M（工资帽 ${summary.cap.cap}M）`,
        ...(roster[0] ? [`队内评分最高球员：${roster[0].name}（综合 ${roster[0].ratings.overall}，角色 ${roster[0].role}）`] : []),
      ];
      const j = await api<{ ok: boolean; text: string }>("/api/ai/news", {
        method: "POST",
        body: JSON.stringify({ saveId, headline: `${summary.userTeam.city} 更衣室周报`, facts, tone: "ANALYSIS" }),
      });
      setNews(j.ok ? [j.text] : [`AI 暂不可用：${j.text}`]);
    } catch (e) {
      setNews([`AI 请求失败：${(e as Error).message}`]);
    } finally {
      setAiBusy(false);
    }
  };

  if (!summary || !league) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…（若长时间无响应，请回到首页选择存档）</div>;

  const conf = summary.userTeam?.conference === "WEST" ? league.west : league.east;
  const rank = conf.findIndex((t) => t.id === summary.userTeam?.id) + 1;
  const upcoming = league.upcoming.filter((g) => g.homeTeamId === summary.userTeam?.id || g.awayTeamId === summary.userTeam?.id).slice(0, 6);
  const recent = league.recent.filter((g) => g.homeTeamId === summary.userTeam?.id || g.awayTeamId === summary.userTeam?.id).slice(0, 6);
  const nameOf = (id: string) => {
    const t = teamMap.get(id);
    return t ? t.abbr : "?";
  };
  const top = roster.slice(0, 6);

  return (
    <div className="grid md:grid-cols-3 gap-4 items-start">
      <div className="md:col-span-2 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="战绩" value={`${summary.userTeam?.wins ?? 0}-${summary.userTeam?.losses ?? 0}`} sub={rank > 0 ? `分区第 ${rank}` : ""} />
          <Stat label="化学反应" value={String(summary.chemistry?.overall ?? "-")} sub="0-100" />
          <Stat label="总薪资" value={summary.cap.totalSalary > 0 ? `${summary.cap.totalSalary.toFixed(1)}M` : "未知（未导入）"} sub={`帽 ${CBA.salaryCap}M / 税线 ${CBA.luxuryTax}M`} />
          <Stat label="奢侈税预估" value={summary.cap.taxBill > 0 ? `${summary.cap.taxBill.toFixed(1)}M` : "无"} sub={summary.cap.overTax ? "超过税线" : "未超税线"} />
        </div>

        <Section
          title="阵容核心"
          right={
            <Link href="/roster" className="text-[12px] text-[var(--accent)]">
              查看全部 →
            </Link>
          }
        >
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {top.map((p) => (
              <div key={p.id} className="panel-2 px-3 py-2 flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-medium">{p.name}</div>
                  <div className="text-[11px] text-[var(--text-dim)]">
                    {p.position} · {p.role}
                  </div>
                </div>
                <div className="text-[18px] font-bold tabular-nums text-[var(--accent)]">{p.ratings.overall}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="近期与未来赛程">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <div className="text-[12px] text-[var(--text-dim)] mb-1.5">最近比赛</div>
              {recent.length === 0 && <div className="text-[12px] text-[var(--text-dim)]">尚未进行比赛</div>}
              {recent.map((g) => {
                const isHome = g.homeTeamId === summary.userTeam?.id;
                const my = isHome ? g.homeScore : g.awayScore;
                const opp = isHome ? g.awayScore : g.homeScore;
                return (
                  <div key={g.id} className="flex items-center justify-between text-[12px] py-1 border-b border-[#1a2440]">
                    <span className="text-[var(--text-dim)]">{g.date.slice(5)} {isHome ? "vs" : "@"} {nameOf(isHome ? g.awayTeamId : g.homeTeamId)}</span>
                    <span className={my != null && opp != null ? (my > opp ? "text-[var(--good)] font-semibold" : "text-[var(--bad)]") : ""}>
                      {my ?? "-"} : {opp ?? "-"}
                    </span>
                  </div>
                );
              })}
            </div>
            <div>
              <div className="text-[12px] text-[var(--text-dim)] mb-1.5">未来赛程</div>
              {upcoming.length === 0 && <div className="text-[12px] text-[var(--text-dim)]">暂无排期（可能已进入休赛期）</div>}
              {upcoming.map((g) => {
                const isHome = g.homeTeamId === summary.userTeam?.id;
                return (
                  <div key={g.id} className="flex items-center justify-between text-[12px] py-1 border-b border-[#1a2440]">
                    <span className="text-[var(--text-dim)]">{g.date.slice(5)} {isHome ? "vs" : "@"} {nameOf(isHome ? g.awayTeamId : g.homeTeamId)}</span>
                    <span className="tag">{g.status === "SCHEDULED" ? "待赛" : "完赛"}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Link href="/sim" className="btn btn-primary">
              前往比赛模拟
            </Link>
            {summary.save.phase === "DRAFT" && (
              <Link href="/draft" className="btn">
                选秀大会进行中 →
              </Link>
            )}
            {summary.save.phase === "FREE_AGENCY" && (
              <Link href="/freeagency" className="btn">
                自由市场开放中 →
              </Link>
            )}
          </div>
        </Section>
      </div>

      <div className="space-y-4">
        <Section
          title="球队简报（GLM 生成）"
          right={
            <button className="btn" onClick={makeNews} disabled={aiBusy}>
              {aiBusy ? "生成中…" : "生成简报"}
            </button>
          }
        >
          {news.length === 0 ? (
            <div className="text-[12px] text-[var(--text-dim)] leading-relaxed">
              点击「生成简报」让 GLM 基于引擎计算的数据撰写周报。AI 功能需要配置 CommandCode 环境变量（见设置页）；未配置时游戏核心功能不受影响。
            </div>
          ) : (
            <div className="text-[12px] leading-relaxed whitespace-pre-wrap">{news[0]}</div>
          )}
        </Section>

        <Section title="存档信息">
          <div className="text-[12px] space-y-1.5 text-[var(--text-dim)]">
            <div>存档：{summary.save.name}</div>
            <div>
              阶段：{PHASE_LABEL[summary.save.phase] ?? summary.save.phase} · {summary.save.currentDate}
            </div>
            <div>数据源：{summary.save.dataProvider}（{summary.save.dataStatus === "DEMO" ? "演示数据" : "真实 NBA 数据"}）</div>
            <div>随机种子：{summary.save.seed}</div>
            <div>规则版本：{summary.cap.cbaVersion}</div>
            <div>评分版本：{summary.save.ratingVersion}</div>
          </div>
        </Section>
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[11px] text-[var(--text-dim)]">{label}</div>
      <div className="text-[20px] font-bold tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-dim)] mt-0.5">{sub}</div>}
    </div>
  );
}
