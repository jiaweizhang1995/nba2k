"use client";

// AI GM 评测运行页：开始（客户端循环驱动 step）/暂停/取消/进度/时间线

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface Turn {
  turnIndex: number;
  stage: string;
  action: string;
  decision: string | null;
  resultSummary: string | null;
  ok: boolean;
  latencyMs: number;
}

interface EvalDetail {
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
    stage: string;
    seasonsDone: number;
    turnIndex: number;
    callCount: number;
    actionCount: number;
    legalCount: number;
    errorCount: number;
    replayOf: string | null;
    strategy: string | null;
  };
  turns: Turn[];
  seasons: { season: number; wins: number; losses: number; playoffResult: string; championName: string | null }[];
  done: boolean;
}

export default function EvalRunPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [detail, setDetail] = useState<EvalDetail | null>(null);
  const [running, setRunning] = useState(false);
  const runRef = useRef(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const j = await api<EvalDetail>(`/api/eval/${id}`);
      setDetail(j);
      return j;
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
      return null;
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const control = async (action: "start" | "pause" | "cancel") => {
    try {
      await api(`/api/eval/${id}/control`, { method: "POST", body: JSON.stringify({ action }) });
      const j = await refresh();
      if (action === "start" && j && (j.evaluation.status === "RUNNING" || j.evaluation.status === "PENDING")) {
        void loop();
      }
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  const loop = useCallback(async () => {
    if (runRef.current) return;
    runRef.current = true;
    setRunning(true);
    try {
      for (;;) {
        const j = await api<{ state: { status: string; done: boolean; lastTurn?: { action: string; decision?: string; summary: string; ok: boolean } } }>(
          `/api/eval/${id}/step`,
          { method: "POST" },
        ).catch((e) => ({ state: { status: `ERROR: ${(e as Error).message}`, done: true } }));
        await refresh();
        if (j.state.status !== "RUNNING" || j.state.done) break;
      }
    } finally {
      runRef.current = false;
      setRunning(false);
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const replay = async () => {
    try {
      const j = await api<{ id: string }>(`/api/eval/${id}/replay`, { method: "POST" });
      routerPush(`/eval/${j.id}`);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  const routerPush = (href: string) => window.location.assign(href);

  if (!detail) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;
  const ev = detail.evaluation;
  const legalRate = ev.actionCount > 0 ? Math.round((ev.legalCount / ev.actionCount) * 100) : null;
  const isRunning = ev.status === "RUNNING" || running;

  return (
    <div className="grid lg:grid-cols-3 gap-4 items-start">
      <div className="lg:col-span-2 space-y-4">
        <Section
          title={`${ev.name} · ${ev.provider === "STUB" ? "STUB" : ev.model ?? "?"}`}
          right={
            <div className="flex gap-2 flex-wrap">
              {(ev.status === "PENDING" || ev.status === "PAUSED") && (
                <button className="btn btn-primary" onClick={() => control("start")} disabled={running}>
                  {ev.status === "PENDING" ? "开始评测" : "继续"}
                </button>
              )}
              {ev.status === "RUNNING" && (
                <button className="btn" onClick={() => control("pause")} disabled={!isRunning}>
                  暂停
                </button>
              )}
              {ev.status !== "DONE" && ev.status !== "CANCELLED" && (
                <button className="btn btn-danger" onClick={() => control("cancel")} disabled={running}>
                  取消
                </button>
              )}
              {ev.status === "DONE" && !ev.replayOf && (
                <>
                  <button className="btn" onClick={replay}>
                    回放（不调用模型）
                  </button>
                  <Link href={`/eval/${id}/result`} className="btn btn-primary">
                    查看结果
                  </Link>
                </>
              )}
              {ev.replayOf && ev.status === "DONE" && <span className="tag tag-imported">回放完成</span>}
            </div>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="状态" value={ev.status} sub={running ? "AI 决策循环中…" : ev.stage} />
            <Stat label="赛季进度" value={`${ev.seasonsDone}/${ev.years}`} sub={`阶段 ${ev.stage}`} />
            <Stat label="调用 / 错误" value={`${ev.callCount} / ${ev.errorCount}`} sub={`动作 ${ev.actionCount} · 合法 ${legalRate == null ? "-" : legalRate + "%"}`} />
            <Stat label="球队 / 种子" value={ev.teamShortId} sub={`种子 ${ev.seed}`} />
          </div>
          {ev.replayOf && (
            <div className="text-[12px] text-[var(--warn)] mt-3 panel-2 p-2 border-[#b45309]">回放模式：按源评测记录的动作序列执行，不调用 Provider。</div>
          )}
        </Section>

        <Section title="赛季结果">
          {detail.seasons.length === 0 ? (
            <div className="text-[13px] text-[var(--text-dim)]">尚无完成的赛季。</div>
          ) : (
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
          )}
        </Section>

        <Section title="决策时间线（公开摘要，不含模型内部推理）">
          <div className="scrollbox max-h-96">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>阶段</th>
                  <th>动作</th>
                  <th>结果</th>
                  <th>决策摘要</th>
                </tr>
              </thead>
              <tbody>
                {[...detail.turns].reverse().map((t) => (
                  <tr key={t.turnIndex}>
                    <td className="text-[var(--text-dim)]">{t.turnIndex}</td>
                    <td>
                      <span className="tag">{t.stage}</span>
                    </td>
                    <td>{t.action}</td>
                    <td className={`text-[12px] ${t.ok ? "" : "text-[var(--bad)]"}`}>{t.resultSummary?.slice(0, 90) ?? (t.ok ? "" : "失败")}</td>
                    <td className="text-[12px] text-[var(--text-dim)]">{t.decision ?? "—"}</td>
                  </tr>
                ))}
                {detail.turns.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-[var(--text-dim)] py-6">
                      尚未开始
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <div className="space-y-4">
        <Section title="评测配置">
          <div className="text-[12px] text-[var(--text-dim)] space-y-1.5">
            <div>Provider：{ev.provider === "STUB" ? "STUB（本地确定性）" : "OpenAI 兼容"}</div>
            <div>模型：{ev.model ?? "—"}</div>
            <div>API Key：{ev.apiKeyMasked ?? "—"}</div>
            <div>策略：{ev.strategy ?? "（未设置）"}</div>
            <div>评测快照与用户存档完全隔离。</div>
          </div>
        </Section>
        <Section title="说明">
          <div className="text-[12px] text-[var(--text-dim)] leading-relaxed">
            「开始」后客户端循环调用服务器 step：每步 = 一次 AI 决策（观察 → 返回动作 JSON → 受控执行 → 记录）。
            暂停/取消立即在服务端生效。完成后可回放：同快照+同种子+同动作序列 ⇒ 相同结果（不调用模型）。
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
      <div className="text-[18px] font-bold tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-dim)] mt-0.5">{sub}</div>}
    </div>
  );
}
