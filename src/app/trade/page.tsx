"use client";

// Trade center: 2-party builder with rule validation, AI GM feedback,
// value breakdowns, and God-Mode forced execution.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, useSave } from "@/components/save-context";
import { Section, Toast, fmtSalary } from "@/components/ui";

interface TeamRow {
  id: string;
  abbr: string;
  city: string;
  name: string;
  aiPhase: string;
  cap: { totalSalary: number };
}
interface AssetPlayer {
  id: string;
  name: string;
  position: string;
  age: number;
  overall: number;
  salary: number;
  role: string;
  noTrade: boolean;
}
interface AssetPick {
  id: string;
  year: number;
  round: number;
  status: string;
  protection: { type: string; x: number | null } | null;
}
interface Side {
  players: string[];
  picks: string[];
}

function AssetList({
  teamId,
  side,
  kind,
  rosters,
  selectedIds,
  onToggle,
}: {
  teamId: string;
  side: "give" | "get";
  kind: "players" | "picks";
  rosters: Map<string, { players: AssetPlayer[]; picks: AssetPick[] }>;
  selectedIds: string[];
  onToggle: (side: "give" | "get", kind: "players" | "picks", id: string) => void;
}) {
  const data = rosters.get(teamId);
  if (!data) return <div className="text-[12px] text-[var(--text-dim)]">加载中…</div>;
  if (kind === "players") {
    return (
      <div className="scrollbox max-h-72">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 28 }}></th>
              <th>球员</th>
              <th>位置</th>
              <th>年龄</th>
              <th>综合</th>
              <th>薪资</th>
            </tr>
          </thead>
          <tbody>
            {data.players.map((p) => (
              <tr key={p.id} onClick={() => onToggle(side, kind, p.id)} style={{ cursor: "pointer" }}>
                <td>{selectedIds.includes(p.id) ? "✓" : ""}</td>
                <td className={p.noTrade ? "text-[var(--bad)]" : ""}>
                  {p.name}
                  {p.noTrade ? " (不可交易)" : ""}
                </td>
                <td>{p.position}</td>
                <td>{p.age}</td>
                <td className="text-[var(--accent)] font-semibold">{p.overall}</td>
                <td>{fmtSalary(p.salary)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {data.picks.map((p) => (
        <button
          key={p.id}
          className={`btn ${selectedIds.includes(p.id) ? "btn-primary" : ""}`}
          onClick={() => onToggle(side, kind, p.id)}
          disabled={p.status !== "OWNED"}
          title={p.protection?.type === "LOTTERY_TOP_X" ? `前 ${p.protection.x} 保护` : "无保护"}
        >
          {p.year} {p.round === 1 ? "首轮" : "次轮"}签
        </button>
      ))}
      {data.picks.length === 0 && <span className="text-[12px] text-[var(--text-dim)]">无可交易选秀权</span>}
    </div>
  );
}

export default function TradePage() {
  const { summary, saveId, refresh } = useSave();
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [partnerId, setPartnerId] = useState("");
  const [rosters, setRosters] = useState<Map<string, { players: AssetPlayer[]; picks: AssetPick[] }>>(new Map());
  const [give, setGive] = useState<Side>({ players: [], picks: [] });
  const [get, setGet] = useState<Side>({ players: [], picks: [] });
  interface Validation { legal: boolean; issues: { code: string; severity: string; message: string }[]; salaryCheck: { partyTeamId: string; incoming: number; outgoing: number; band: string; ok: boolean }[] }
  interface Feedback { teamId: string; verdict: { accept: boolean; valueDelta: number; feedback: string; reasons: string[] } }
  const [validation, setValidation] = useState<Validation | null>(null);
  const [feedback, setFeedback] = useState<Feedback[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const isGod = !!summary?.save.godMode;

  const loadTeam = useCallback(
    async (id: string) => {
      if (!saveId || !id) return;
      const full = `${saveId}:${id}`;
      const [r, a] = await Promise.all([
        api<{ players: { id: string; name: string; position: string; age: number; ratings: { overall: number }; contract: { years: { season: number; salary: number }[]; noTrade: boolean }; role: string; status: string }[] }>(
          `/api/saves/${saveId}/roster?teamId=${encodeURIComponent(full)}`,
        ),
        api<{ assets: { picks: AssetPick[]; contracts: { id: string }[] } }>(`/api/saves/${saveId}/assets?teamId=${encodeURIComponent(id)}`),
      ]);
      const players: AssetPlayer[] = r.players
        .filter((p) => p.status === "ACTIVE" || p.status === "INJURED")
        .map((p) => ({ id: p.id, name: p.name, position: p.position, age: p.age, overall: p.ratings.overall, salary: p.contract.years[0]?.salary ?? 0, role: p.role, noTrade: p.contract.noTrade }));
      setRosters((m) => new Map(m.set(id, { players, picks: a.assets.picks })));
    },
    [saveId],
  );

  useEffect(() => {
    if (!saveId) return;
    api<{ teams: TeamRow[] }>(`/api/saves/${saveId}/teams`).then((j) => {
      setTeams(j.teams);
      if (summary?.userTeam) {
        void loadTeam(summary.userTeam.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, summary?.userTeam?.id]);

  useEffect(() => {
    if (partnerId) void loadTeam(partnerId);
  }, [partnerId, loadTeam]);

  const userTeamId = summary?.userTeam?.id ?? "";
  const partner = teams.find((t) => t.id === partnerId);

  const toggle = (side: "give" | "get", kind: "players" | "picks", id: string) => {
    const setter = side === "give" ? setGive : setGet;
    setter((s) => ({ ...s, [kind]: s[kind].includes(id) ? s[kind].filter((x) => x !== id) : [...s[kind], id] }));
  };

  const buildParties = useMemo(
    () => () => {
      const parties = [
        {
          teamId: userTeamId,
          gives: [
            ...give.players.map((id) => ({ kind: "PLAYER" as const, id })),
            ...give.picks.map((id) => ({ kind: "PICK" as const, id })),
          ],
          receives: [
            ...get.players.map((id) => ({ kind: "PLAYER" as const, id })),
            ...get.picks.map((id) => ({ kind: "PICK" as const, id })),
          ],
        },
        {
          teamId: partnerId,
          gives: [
            ...get.players.map((id) => ({ kind: "PLAYER" as const, id })),
            ...get.picks.map((id) => ({ kind: "PICK" as const, id })),
          ],
          receives: [
            ...give.players.map((id) => ({ kind: "PLAYER" as const, id })),
            ...give.picks.map((id) => ({ kind: "PICK" as const, id })),
          ],
        },
      ];
      return parties;
    },
    [userTeamId, partnerId, give, get],
  );

  const validate = async () => {
    setBusy(true);
    try {
      const parties = buildParties();
      const j = await api<{ validation: Validation; feedback: Feedback[] }>(`/api/saves/${saveId}/trade`, { method: "PUT", body: JSON.stringify({ parties }) });
      setValidation(j.validation);
      setFeedback(j.feedback);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  const execute = async (force: boolean) => {
    setBusy(true);
    try {
      const parties = buildParties();
      const j = await api<{ result: { executed: boolean; validation?: Validation; aiFeedback?: Feedback[] } }>(`/api/saves/${saveId}/trade`, {
        method: "POST",
        body: JSON.stringify({ parties, force, note: force ? "GOD MODE 强制成交" : undefined }),
      });
      if (j.result.executed) {
        setToast({ msg: "交易完成！已写入事件日志。", kind: "ok" });
        setGive({ players: [], picks: [] });
        setGet({ players: [], picks: [] });
        setValidation(null);
        setFeedback(null);
        await Promise.all([loadTeam(userTeamId), partnerId ? loadTeam(partnerId) : Promise.resolve(), refresh()]);
      } else {
        setValidation(j.result.validation ?? null);
        setToast({ msg: "交易未通过规则校验", kind: "err" });
      }
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;


  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[13px] font-semibold">{summary.userTeam?.city} {summary.userTeam?.name}</span>
        <span className="text-[var(--text-dim)]">⇄</span>
        <select className="input max-w-60" value={partnerId} onChange={(e) => { setPartnerId(e.target.value); setGet({ players: [], picks: [] }); }}>
          <option value="">选择交易伙伴…</option>
          {teams.filter((t) => t.id !== userTeamId).map((t) => (
            <option key={t.id} value={t.id}>
              {t.city} {t.name}（{t.aiPhase}，薪资 {t.cap.totalSalary.toFixed(0)}M）
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={validate} disabled={busy || !partnerId}>
          校验交易
        </button>
        <button
          className="btn btn-primary"
          onClick={() => execute(false)}
          disabled={busy || !partnerId || !validation?.legal}
          title={validation && !validation.legal ? "存在阻断项，无法执行" : "执行交易"}
        >
          执行交易
        </button>
        {isGod && (
          <button className="btn btn-god" onClick={() => execute(true)} disabled={busy || !partnerId} title="GOD MODE：跳过规则强制成交（将写入审计日志）">
            GOD 强制成交
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="你送出（Give）">
          <div className="space-y-3">
            <div className="text-[12px] text-[var(--text-dim)]">球员</div>
            <AssetList teamId={userTeamId} side="give" kind="players" rosters={rosters} selectedIds={give.players} onToggle={toggle} />
            <div className="text-[12px] text-[var(--text-dim)]">选秀权</div>
            <AssetList teamId={userTeamId} side="give" kind="picks" rosters={rosters} selectedIds={give.picks} onToggle={toggle} />
          </div>
        </Section>
        <Section title="你收到（Get）">
          <div className="space-y-3">
            <div className="text-[12px] text-[var(--text-dim)]">球员</div>
            <AssetList teamId={partnerId} side="get" kind="players" rosters={rosters} selectedIds={get.players} onToggle={toggle} />
            <div className="text-[12px] text-[var(--text-dim)]">选秀权</div>
            <AssetList teamId={partnerId} side="get" kind="picks" rosters={rosters} selectedIds={get.picks} onToggle={toggle} />
          </div>
        </Section>
      </div>

      {validation && (
        <Section title="规则校验（LEAGUE CBA v1.0 / TRADE-RULES v1.0）">
          <div className="space-y-2">
            <div className={`text-[13px] font-semibold ${validation.legal ? "text-[var(--good)]" : "text-[var(--bad)]"}`}>
              {validation.legal ? "✓ 通过规则校验，可以执行" : "✕ 未通过规则校验"}
            </div>
            {validation.salaryCheck.map((s) => (
              <div key={s.partyTeamId} className="panel-2 px-3 py-2 text-[12px]">
                <div className={s.ok ? "text-[var(--good)]" : "text-[var(--bad)]"}>
                  {teams.find((t) => t.id === s.partyTeamId)?.abbr ?? s.partyTeamId}：送出 {s.outgoing.toFixed(2)}M → 接收 {s.incoming.toFixed(2)}M {s.ok ? "✓" : "✕"}
                </div>
                <div className="text-[var(--text-dim)] mt-0.5">{s.band}</div>
              </div>
            ))}
            {validation.issues.map((i, idx) => (
              <div key={idx} className={`px-3 py-2 rounded text-[12px] ${i.severity === "BLOCKER" ? "bg-[#450a0a] text-[#fca5a5]" : "bg-[#451a03] text-[#fcd34d]"}`}>
                [{i.code}] {i.message}
              </div>
            ))}
          </div>
        </Section>
      )}

      {feedback && (
        <Section title={`对方 GM 反馈${partner ? `（${partner.city} ${partner.name}）` : ""}`}>
          {feedback.map((f) => (
            <div key={f.teamId} className="panel-2 p-3 mb-2">
              <div className={`text-[13px] font-semibold ${f.verdict.accept ? "text-[var(--good)]" : "text-[var(--bad)]"}`}>
                {f.verdict.accept ? "愿意成交" : "拒绝当前方案"}（价值差 {f.verdict.valueDelta > 0 ? "+" : ""}
                {f.verdict.valueDelta} 点）
              </div>
              <div className="text-[13px] mt-1">“{f.verdict.feedback}”</div>
              <div className="text-[11px] text-[var(--text-dim)] mt-1.5 leading-relaxed">{f.verdict.reasons.join("；")}</div>
            </div>
          ))}
          <div className="text-[11px] text-[var(--text-dim)]">
            说明：接受/拒绝由规则引擎基于估值、球队阶段与风险偏好计算，AI 仅润色谈判语气，不决定交易结果。
          </div>
        </Section>
      )}

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
