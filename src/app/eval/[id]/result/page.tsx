"use client";

// 评测结果页：统一结果面板（GM-BENCH v1）

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/components/save-context";
import { Section } from "@/components/ui";

interface Detail {
  evaluation: {
    id: string;
    name: string;
    provider: string;
    model: string | null;
    apiKeyMasked: string | null;
    teamShortId: string;
    seed: number;
    years: number;
    status: string;
    replayOf: string | null;
    score: {
      version: string;
      score: number;
      totalWins: number;
      totalLosses: number;
      winsPerSeason: number;
      seasonsRecorded: number;
      playoffCount: number;
      finalsCount: number;
      champCount: number;
      legalRate: number;
      errorRate: number;
      actionCount: number;
      callCount: number;
      errorCount: number;
      latencyMsSum: number;
      tokensIn: number;
      tokensOut: number;
      costCents: number;
      finalChemistry: number;
      tradeCount: number;
      trades: string[];
      formula: string;
      replayMatch?: boolean;
      sourceScore?: number;
    } | null;
    strategy: string | null;
  };
  turns: { turnIndex: number; stage: string; action: string; decision: string | null; resultSummary: string | null; ok: boolean }[];
  seasons: { season: number; wins: number; losses: number; playoffResult: string; championName: string | null }[];
  tradeEvents: { id: string; message: string }[];
  cap: { totalSalary: number; capSpace: number; overTax: boolean; taxBill: number };
  chemistry: { overall: number };
  team: { city: string; name: string; abbr: string } | null;
  done: boolean;
}

export default function EvalResultPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    api<Detail>(`/api/eval/${id}`)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [id]);

  if (!detail) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;
  const ev = detail.evaluation;
  const score = ev.score;

  return (
    <div className="space-y-4">
      <Section
        title={`评测结果：${ev.name}`}
        right={
          <div className="flex gap-2">
            <Link href={`/eval/${id}`} className="btn">
              运行页
            </Link>
            <Link href="/eval/compare" className="btn">
              模型对比
            </Link>
          </div>
        }
      >
        {!score ? (
          <div className="text-[13px] text-[var(--text-dim)]">评测尚未完成（当前状态 {ev.status}）。完成后面板会显示全部指标。</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <Big label="GM-BENCH 得分" value={String(score.score)} sub={score.version} accent />
              <Big label="总胜场" value={`${score.totalWins}胜 ${score.totalLosses}负`} sub={`场均 ${score.winsPerSeason} 胜 × ${score.seasonsRecorded} 季`} />
              <Big label="季后赛 / 总决赛 / 冠军" value={`${score.playoffCount} / ${score.finalsCount} / ${score.champCount}`} />
              <Big label="球队化学反应" value={String(score.finalChemistry)} sub={`${detail.team?.city ?? ""} ${detail.team?.name ?? ""}`} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Big label="交易数" value={String(score.tradeCount)} sub="明细见下方" />
              <Big label="合法操作率" value={`${Math.round(score.legalRate * 100)}%`} sub={`动作 ${score.actionCount}`} />
              <Big label="错误率 / 调用" value={`${Math.round(score.errorRate * 100)}% / ${score.callCount}`} sub={`耗时 ${(score.latencyMsSum / 1000).toFixed(1)}s`} />
              <Big label="Token / 成本" value={`${score.tokensIn + score.tokensOut}`} sub={`${score.costCents} 美分（如 Provider 返回）`} />
            </div>
            {ev.replayOf && (
              <div className={`mt-3 px-3 py-2 rounded text-[12px] ${score.replayMatch ? "bg-[#052e16] text-[#86efac]" : "bg-[#450a0a] text-[#fca5a5]"}`}>
                回放一致性：{score.replayMatch ? "✓ 与源评测结果完全一致（确定性验证通过）" : "✗ 与源评测不一致"}
                {score.sourceScore != null ? `（源评测得分 ${score.sourceScore}，回放得分 ${score.score}）` : ""}
              </div>
            )}
            <div className="text-[11px] text-[var(--text-dim)] mt-3 panel-2 p-2.5">
              评分公式（{score.version}）：{score.formula}
              <br />
              模型 {ev.provider === "STUB" ? "STUB（本地确定性）" : `${ev.model ?? "?"} @ ${ev.provider}`} · Key {ev.apiKeyMasked ?? "—"} · 种子 {ev.seed} · 球队 {ev.teamShortId} · {ev.years} 年
              <br />
              建队策略：{ev.strategy ?? "（未设置）"}
            </div>
          </>
        )}
      </Section>

      {detail.seasons.length > 0 && (
        <Section title="逐赛季结果">
          <table className="data">
            <thead>
              <tr>
                <th>赛季</th>
                <th>战绩</th>
                <th>季后赛</th>
                <th>总冠军</th>
              </tr>
            </thead>
            <tbody>
              {detail.seasons.map((s) => (
                <tr key={s.season}>
                  <td>{s.season - 1}-{String(s.season).slice(2)}</td>
                  <td className="font-semibold">
                    {s.wins}-{s.losses}
                  </td>
                  <td>{s.playoffResult}</td>
                  <td>{s.championName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Section title={`交易明细（${detail.tradeEvents.length}）`}>
          {detail.tradeEvents.length === 0 ? (
            <div className="text-[12px] text-[var(--text-dim)]">评测期间没有达成交易。</div>
          ) : (
            <div className="space-y-1.5 text-[12px]">
              {detail.tradeEvents.map((t) => (
                <div key={t.id} className="panel-2 px-3 py-2">
                  {t.message}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="选秀与签约">
          <div className="space-y-1.5 text-[12px] max-h-64 scrollbox">
            {detail.turns
              .filter((t) => t.action === "draft_pick" || t.action === "finish_draft" || t.action === "sign_free_agent")
              .map((t) => (
                <div key={t.turnIndex} className="panel-2 px-3 py-2">
                  <span className="tag mr-2">{t.action === "sign_free_agent" ? "签约" : "选秀"}</span>
                  {t.resultSummary ?? t.action}
                </div>
              ))}
            {detail.turns.filter((t) => t.action === "draft_pick" || t.action === "finish_draft" || t.action === "sign_free_agent").length === 0 && (
              <div className="text-[var(--text-dim)]">评测期间没有选秀/签约操作。</div>
            )}
          </div>
        </Section>
      </div>

      <Section title="薪资与资产">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Big label="当前薪资总额" value={`${detail.cap.totalSalary.toFixed(1)}M`} sub={detail.cap.overTax ? "超税线" : "未超税线"} />
          <Big label="薪资空间" value={`${detail.cap.capSpace.toFixed(1)}M`} />
          <Big label="奢侈税预估" value={detail.cap.taxBill > 0 ? `${detail.cap.taxBill.toFixed(1)}M` : "无"} />
          <Big label="化学反应" value={String(detail.chemistry.overall)} />
        </div>
      </Section>

      <Section title="决策时间线">
        <div className="scrollbox max-h-[420px]">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>阶段</th>
                <th>动作</th>
                <th>决策摘要</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {detail.turns.map((t) => (
                <tr key={t.turnIndex}>
                  <td className="text-[var(--text-dim)]">{t.turnIndex}</td>
                  <td>
                    <span className="tag">{t.stage}</span>
                  </td>
                  <td>{t.action}</td>
                  <td className="text-[12px] text-[var(--text-dim)] whitespace-normal">{t.decision ?? "—"}</td>
                  <td className={`text-[12px] whitespace-normal ${t.ok ? "" : "text-[var(--bad)]"}`}>{t.resultSummary?.slice(0, 120) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Big({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="panel p-3">
      <div className="text-[11px] text-[var(--text-dim)]">{label}</div>
      <div className={`text-[20px] font-bold tabular-nums mt-0.5 ${accent ? "text-[var(--accent)]" : ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-dim)] mt-0.5">{sub}</div>}
    </div>
  );
}
