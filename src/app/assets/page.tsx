"use client";

// Assets page: cap snapshot, future picks, contract obligations.

import { useCallback, useEffect, useState } from "react";
import { api, useSave } from "@/components/save-context";
import { Section, DataTable, Toast, fmtSalary } from "@/components/ui";
import { CBA } from "@/domain/salary";

interface AssetsResp {
  assets: {
    cap: { totalSalary: number; capSpace: number; overCap: boolean; overTax: boolean; overFirstApron: boolean; overSecondApron: boolean; taxBill: number; rosterCount: number };
    picks: { id: string; year: number; round: number; status: string; protection: { type: string; x: number | null } | null; originalTeamId: string }[];
    contracts: { id: string; name: string; overall: number; contract: { type: string; years: { season: number; salary: number }[]; noTrade: boolean } }[];
    versions: Record<string, string>;
  };
}

export default function AssetsPage() {
  const { summary, saveId } = useSave();
  const [data, setData] = useState<AssetsResp["assets"] | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const userTeamId = summary?.userTeam?.id;
  const load = useCallback(async () => {
    if (!saveId || !userTeamId) return;
    try {
      const j = await api<AssetsResp>(`/api/saves/${saveId}/assets?teamId=${encodeURIComponent(userTeamId)}`);
      setData(j.assets);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  }, [saveId, userTeamId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…</div>;
  if (!data) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载资产中…</div>;
  const cap = data.cap;
  const season = summary.save.season;

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      <div className="space-y-4">
        <Section title="薪资空间">
          <div className="space-y-2 text-[13px]">
            <div className="flex justify-between panel-2 px-3 py-2">
              <span>总薪资</span>
              <b className={cap.overTax ? "text-[var(--bad)]" : ""}>{cap.totalSalary.toFixed(2)}M</b>
            </div>
            <div className="flex justify-between panel-2 px-3 py-2">
              <span>工资帽</span>
              <b>{CBA.salaryCap}M</b>
            </div>
            <div className="flex justify-between panel-2 px-3 py-2">
              <span>薪资空间</span>
              <b className={cap.capSpace > 0 ? "text-[var(--good)]" : "text-[var(--bad)]"}>{cap.capSpace > 0 ? `+${cap.capSpace.toFixed(2)}M` : `${cap.capSpace.toFixed(2)}M（超帽）`}</b>
            </div>
            <div className="flex justify-between panel-2 px-3 py-2">
              <span>奢侈税线 / 税单</span>
              <b>
                {CBA.luxuryTax}M · {cap.taxBill > 0 ? `${cap.taxBill.toFixed(2)}M` : "无"}
              </b>
            </div>
            <div className="flex justify-between panel-2 px-3 py-2">
              <span>土豪线（一 / 二）</span>
              <b className={cap.overSecondApron ? "text-[var(--bad)]" : ""}>
                {CBA.firstApron}M / {CBA.secondApron}M{cap.overSecondApron ? "（已超二土豪线）" : ""}
              </b>
            </div>
            <div className="flex justify-between panel-2 px-3 py-2">
              <span>阵容人数</span>
              <b>
                {cap.rosterCount} / {CBA.maxRosterSize}（最少 {CBA.minRosterSize}）
              </b>
            </div>
          </div>
          <div className="text-[11px] text-[var(--text-dim)] mt-3 leading-relaxed panel-2 p-2.5">
            规则版本：{data.versions.cba} · {data.versions.trade} · {data.versions.chemistry}
            <br />
            规则为本模拟联赛（虚构联盟）的内部规则，非现实联赛规则；数值全部版本化并展示。
          </div>
        </Section>

        <Section title={`未来选秀权（${season} – ${season + 6}）`}>
          <div className="flex flex-wrap gap-1.5">
            {data.picks
              .filter((p) => p.status === "OWNED")
              .sort((a, b) => a.year - b.year || a.round - b.round)
              .map((p) => (
                <span key={p.id} className="tag" style={{ color: p.round === 1 ? "var(--accent)" : undefined, borderColor: p.round === 1 ? "var(--accent)" : undefined }}>
                  {p.year} 首轮×{p.round}
                  {p.protection?.type === "LOTTERY_TOP_X" ? `（前${p.protection.x}保护）` : ""}
                </span>
              ))}
            {data.picks.filter((p) => p.status === "OWNED").length === 0 && <span className="text-[12px] text-[var(--text-dim)]">无自有选秀权（可能在交易中送出）</span>}
          </div>
          {data.picks.some((p) => p.status !== "OWNED") && (
            <div className="text-[11px] text-[var(--text-dim)] mt-2">已送出：{data.picks.filter((p) => p.status !== "OWNED").length} 个签位</div>
          )}
        </Section>
      </div>

      <Section title="合同簿">
        <DataTable
          rows={data.contracts as unknown as Record<string, unknown>[]}
          rowKey={(r) => String(r.id)}
          initialSort={{ key: "salary0", dir: "desc" }}
          columns={[
            { key: "name", label: "球员", render: (r) => <span className="font-medium">{String(r.name)}</span> },
            { key: "overall", label: "综合", render: (r) => String(r.overall) },
            {
              key: "salary0",
              label: `${season} 薪资`,
              render: (r) => fmtSalary((r.contract as AssetsResp["assets"]["contracts"][number]["contract"]).years[0]?.salary),
            },
            {
              key: "end",
              label: "到期",
              render: (r) => {
                const years = (r.contract as AssetsResp["assets"]["contracts"][number]["contract"]).years;
                return years.length ? String(years[years.length - 1].season) : "未知";
              },
            },
            { key: "type", label: "类型", render: (r) => String((r.contract as AssetsResp["assets"]["contracts"][number]["contract"]).type) },
            {
              key: "flags",
              label: "条款",
              render: (r) => {
                const c = (r.contract as AssetsResp["assets"]["contracts"][number]["contract"]);
                return [c.noTrade ? "不可交易" : null].filter(Boolean).join("、") || "—";
              },
            },
          ]}
        />
      </Section>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
