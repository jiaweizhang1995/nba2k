"use client";

// AI GM 评测：配置新评测 + 评测列表

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface EvalRow {
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
  callCount: number;
  errorCount: number;
  score: { score?: number; version?: string; totalWins?: number; champCount?: number; replayMatch?: boolean } | null;
  replayOf: string | null;
  createdAt: string;
}

interface SaveRow {
  id: string;
  name: string;
  dataStatus: string;
}

export default function EvalConfigPage() {
  const router = useRouter();
  const [evals, setEvals] = useState<EvalRow[]>([]);
  const [saves, setSaves] = useState<SaveRow[]>([]);
  const [teams, setTeams] = useState<{ id: string; city: string; name: string }[]>([]);
  const [name, setName] = useState("评测 1");
  const [baseSaveId, setBaseSaveId] = useState("");
  const [teamShortId, setTeamShortId] = useState("");
  const [seed, setSeed] = useState("20272027");
  const [years, setYears] = useState<3 | 5>(3);
  const [provider, setProvider] = useState<"STUB" | "OPENAI_COMPAT">("STUB");
  const [baseUrl, setBaseUrl] = useState("https://api.commandcode.ai/provider/v1/chat/completions");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const load = useCallback(async () => {
    const [e, s] = await Promise.all([
      api<{ evaluations: EvalRow[] }>("/api/eval").catch(() => ({ evaluations: [] })),
      api<{ saves: SaveRow[] }>("/api/saves").catch(() => ({ saves: [] })),
    ]);
    setEvals(e.evaluations);
    setSaves(s.saves);
    if (!baseSaveId && s.saves.length > 0) {
      setBaseSaveId(s.saves[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!baseSaveId) return;
    api<{ teams: { id: string; city: string; name: string }[] }>(`/api/saves/${baseSaveId}/teams`)
      .then((j) => setTeams(j.teams))
      .catch(() => setTeams([]));
  }, [baseSaveId]);

  const create = async () => {
    setBusy(true);
    try {
      const j = await api<{ id: string }>("/api/eval", {
        method: "POST",
        body: JSON.stringify({
          name,
          baseSaveId,
          teamShortId: teamShortId || teams[0]?.id,
          seed: Number(seed) || 1,
          years,
          provider,
          baseUrl: provider === "OPENAI_COMPAT" ? baseUrl : undefined,
          model: provider === "OPENAI_COMPAT" ? model : undefined,
          apiKey: provider === "OPENAI_COMPAT" ? apiKey : undefined,
        }),
      });
      router.push(`/eval/${j.id}`);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      <Section title="创建 AI GM 评测">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[12px] text-[var(--text-dim)] block mb-1">评测名称</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </div>
            <div>
              <label className="text-[12px] text-[var(--text-dim)] block mb-1">随机种子（相同种子可复现/对比）</label>
              <input className="input" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          <div>
            <label className="text-[12px] text-[var(--text-dim)] block mb-1">基准存档（评测在其独立快照上进行，不修改原存档）</label>
            <select
              className="input"
              value={baseSaveId}
              onChange={(e) => {
                setBaseSaveId(e.target.value);
                setTeamShortId("");
              }}
            >
              {saves.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.dataStatus === "DEMO" ? "演示数据" : "真实数据"}）
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[12px] text-[var(--text-dim)] block mb-1">执教球队</label>
              <select className="input" value={teamShortId} onChange={(e) => setTeamShortId(e.target.value)}>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.city} {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[12px] text-[var(--text-dim)] block mb-1">评测年限</label>
              <select className="input" value={years} onChange={(e) => setYears(Number(e.target.value) as 3 | 5)}>
                <option value={3}>3 年</option>
                <option value={5}>5 年</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[12px] text-[var(--text-dim)] block mb-1">Provider</label>
              <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as "STUB" | "OPENAI_COMPAT")}>
                <option value="STUB">STUB（本地确定性测试）</option>
                <option value="OPENAI_COMPAT">OpenAI 兼容</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-[12px] text-[var(--text-dim)] block mb-1">Provider URL（完整 chat/completions 地址）</label>
              <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={provider === "STUB"} placeholder="https://…/v1/chat/completions" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[12px] text-[var(--text-dim)] block mb-1">模型名</label>
              <input className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={provider === "STUB"} placeholder="例如 gpt-4o-mini / glm-4.7" />
            </div>
            <div>
              <label className="text-[12px] text-[var(--text-dim)] block mb-1">API Key（仅服务端加密存储，不进日志/客户端）</label>
              <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={provider === "STUB"} placeholder="sk-…" />
            </div>
          </div>
          <div className="text-[11px] text-[var(--text-dim)] leading-relaxed panel-2 p-2.5">
            评测通过受控工具运营球队（查看阵容/市场、提议交易、签约、选秀、推进赛季）。所有操作经服务器规则裁决，
            LLM 不能修改数据库、调用 God Mode 或绕过规则；只记录其主动提交的公开决策摘要。
          </div>
          <button className="btn btn-primary w-full" onClick={create} disabled={busy || !baseSaveId || !teams.length}>
            {busy ? "创建快照中…" : "创建评测快照并配置"}
          </button>
        </div>
      </Section>

      <div className="space-y-4">
        <Section title="评测列表" right={<Link href="/eval/compare" className="text-[12px] text-[var(--accent)]">模型对比 →</Link>}>
          {evals.length === 0 && <div className="text-[13px] text-[var(--text-dim)] py-4">还没有评测。</div>}
          <div className="space-y-2">
            {evals.map((e) => (
              <div key={e.id} className="panel-2 px-3 py-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/eval/${e.id}`} className="text-[13px] font-semibold hover:text-[var(--accent)]">
                    {e.name}
                  </Link>
                  <span className="tag">{e.provider === "STUB" ? "STUB" : e.model ?? "?"}</span>
                  <span className={`tag ${e.status === "DONE" ? "tag-imported" : e.status === "ERROR" ? "tag-god" : ""}`}>{e.status}</span>
                  <span className="text-[11px] text-[var(--text-dim)]">
                    {e.years} 年 · 种子 {e.seed} · {e.teamShortId} · {e.seasonsDone} 赛季完成
                  </span>
                </div>
                <div className="text-[11px] text-[var(--text-dim)] mt-1 flex gap-3 items-center flex-wrap">
                  {e.score?.score != null && <span>GM-BENCH v1：<b className="text-[var(--accent)]">{e.score.score}</b> 分 · {e.score.totalWins} 胜 {e.score.champCount ?? 0} 冠</span>}
                  {e.replayOf && <span className="tag">回放{e.score?.replayMatch === true ? " ✓ 一致" : e.score?.replayMatch === false ? " ✗ 不一致" : ""}</span>}
                  <Link href={`/eval/${e.id}`} className="text-[var(--accent)]">运行/详情</Link>
                  {e.status === "DONE" && !e.replayOf && <Link href={`/eval/${e.id}/result`} className="text-[var(--accent)]">结果</Link>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
