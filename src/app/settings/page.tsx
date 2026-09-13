"use client";

// Settings: data sources & import, GLM config status, God Mode, rule versions.

import { useCallback, useEffect, useState } from "react";
import { api, useSave } from "@/components/save-context";
import { Section, Toast, ProvenanceTag } from "@/components/ui";
import { CBA } from "@/domain/salary";

interface GlmStatus {
  configured: boolean;
  missingEnvVars: string[];
  url: string | null;
  model: string | null;
  apiKeyMasked: string | null;
}
interface SourceRow {
  id: string;
  provider: string;
  sourceUrl: string | null;
  retrievedAt: string | null;
  season: number | null;
  licenseNote: string;
  status: string;
  records: number;
}

export default function SettingsPage() {
  const { summary, saveId, refresh } = useSave();
  const [glm, setGlm] = useState<GlmStatus | null>(null);
  const [glmTest, setGlmTest] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [provider, setProvider] = useState("CSV_JSON");
  const [season, setSeason] = useState("2027");
  const [sourceUrl, setSourceUrl] = useState("");
  const [csvText, setCsvText] = useState("");
  const [contractOnly, setContractOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const isGod = !!summary?.save.godMode;

  const load = useCallback(async () => {
    if (!saveId) return;
    const [g, s] = await Promise.all([
      api<GlmStatus & { ok: boolean }>("/api/settings/glm"),
      api<{ sources: SourceRow[] }>(`/api/saves/${saveId}/datasources`),
    ]);
    setGlm(g);
    setSources(s.sources);
  }, [saveId]);

  useEffect(() => {
    void load();
  }, [load]);

  const testGlm = async () => {
    setBusy("glm");
    setGlmTest(null);
    try {
      const j = await api<{ health: { ok: boolean; message: string } }>("/api/settings/glm", { method: "POST" });
      setGlmTest(j.health.message);
    } catch (e) {
      setGlmTest((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleGod = async () => {
    if (!isGod && !window.confirm("GOD MODE 会跳过交易规则、允许修改任何资产与球员属性。\n所有操作会被审计日志记录并显示 GOD MODE 标记。\n\n确定开启？")) return;
    try {
      await api(`/api/saves/${saveId}/god?action=toggle`, { method: "POST", body: JSON.stringify({ enabled: !isGod }) });
      setToast({ msg: isGod ? "GOD MODE 已关闭" : "GOD MODE 已开启", kind: "ok" });
      await refresh();
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  const undoGod = async () => {
    try {
      await api(`/api/saves/${saveId}/god`, { method: "POST", body: JSON.stringify({ op: "undo", params: {} }) });
      setToast({ msg: "已撤销最近一次 GOD 操作", kind: "ok" });
      await refresh();
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  const runImport = async () => {
    setBusy("import");
    try {
      const body: Record<string, unknown> = { provider, season: Number(season), sourceUrl: sourceUrl || undefined };
      if (provider === "CSV_JSON") {
        body.playersCsv = csvText;
        if (contractOnly) body.mode = "CONTRACTS";
      }
      const j = await api<{ result: { playersImported: number; teamsImported: number; warnings: string[] } }>(`/api/saves/${saveId}/import`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setToast({ msg: `导入完成：${j.result.playersImported} 名球员 / ${j.result.teamsImported} 支球队`, kind: "ok" });
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(null);
    }
  };

  if (!summary) return <div className="text-[13px] text-[var(--text-dim)] p-4">加载中…（请先在首页进入存档）</div>;

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      <div className="space-y-4">
        <Section title="GLM / CommandCode 配置">
          {glm ? (
            <div className="space-y-2 text-[12px]">
              <div className="flex justify-between">
                <span className="text-[var(--text-dim)]">状态</span>
                <b className={glm.configured ? "text-[var(--good)]" : "text-[var(--bad)]"}>{glm.configured ? "已配置" : `缺少 ${glm.missingEnvVars.join(", ")}`}</b>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-dim)]">接口地址</span>
                <span className="truncate max-w-72 text-right">{glm.url ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-dim)]">模型</span>
                <span>{glm.model ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-dim)]">API Key</span>
                <span>{glm.apiKeyMasked ?? "未设置（服务端环境变量 COMMANDCODE_API_KEY）"}</span>
              </div>
              <div className="text-[11px] text-[var(--text-dim)] leading-relaxed panel-2 p-2.5">
                Key 只从服务端环境变量读取，不会出现在浏览器或代码仓库。若 Key 曾在聊天/截图中泄露，请立即在平台侧吊销并生成新 Key。
                AI 功能不可用时，游戏核心（模拟、交易、选秀、自由市场）不受影响。
              </div>
              <div className="flex gap-2 items-center">
                <button className="btn" onClick={testGlm} disabled={busy === "glm"}>
                  {busy === "glm" ? "测试中…" : "测试连通性"}
                </button>
                {glmTest && <span className={glmTest.includes("正常") ? "text-[var(--good)]" : "text-[var(--bad)]"}>{glmTest}</span>}
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-[var(--text-dim)]">加载中…</div>
          )}
        </Section>

        <Section title="GOD MODE">
          <div className={`panel-2 p-3 mb-3 text-[12px] leading-relaxed ${isGod ? "border-[#dc2626] text-[#fca5a5]" : "text-[var(--text-dim)]"}`}>
            {isGod ? (
              <>
                <b>GOD MODE 已启用。</b>当前可：强制交易、修改球员评分/年龄/合同/伤情、授予选秀权、跳过阶段。所有操作写入审计日志；每个操作前自动创建快照。
              </>
            ) : (
              <>默认关闭。开启后可跳过规则校验并直接修改资产。开启前会要求确认，所有操作均以 GOD MODE 标记记录在「操作日志」。</>
            )}
          </div>
          <div className="flex gap-2">
            <button className={isGod ? "btn btn-danger" : "btn btn-god"} onClick={toggleGod}>
              {isGod ? "关闭 GOD MODE" : "开启 GOD MODE"}
            </button>
            {isGod && (
              <button className="btn btn-god" onClick={undoGod}>
                撤销最近一次 GOD 操作
              </button>
            )}
          </div>
        </Section>
      </div>

      <div className="space-y-4">
        <Section title="数据导入（真实数据接入）">
          <div className="text-[11px] text-[var(--text-dim)] leading-relaxed panel-2 p-2.5 mb-3">
            {summary?.save.dataStatus === "DEMO" ? (
              <>
                本存档当前为 <b>DEMO 数据</b>（虚构联盟）。接入真实数据的三种方式：
                <br />1. <b>BALLDONTLIE</b>：免费开发档，需 API Key（环境变量 <code>BALLDONTLIE_API_KEY</code>），不含合同/薪资数据；
                <br />2. <b>Sportradar</b>：正式授权数据，需商业授权 Key；
                <br />3. <b>CSV/JSON 上传</b>：自行准备数据并注明来源（sourceUrl），格式见 README。
                <br />
                没有授权数据时本页不会伪造任何真实联赛数据。也可回到首页新建存档——新存档默认即内置真实 NBA 数据。
              </>
            ) : (
              <>
                本存档为 <b>真实 NBA 数据</b>（{summary?.save.dataProvider ?? "WIKIPEDIA"}，溯源见下方「数据来源」）。
                如需更新名单/统计/合同，可在下方重新导入覆盖整个联盟；只补合同可勾选「仅合并合同」。
              </>
            )}
          </div>
          <div className="space-y-2">
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="CSV_JSON">CSV / JSON 上传</option>
              <option value="BALLDONTLIE">BALLDONTLIE（需要服务端配置 Key）</option>
              <option value="SPORTRADAR">Sportradar（需要授权）</option>
            </select>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[12px] text-[var(--text-dim)] block mb-1">赛季标签</label>
                <input className="input" value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ""))} />
              </div>
              <div>
                <label className="text-[12px] text-[var(--text-dim)] block mb-1">来源 URL（必填，用于 provenance）</label>
                <input className="input" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://..." />
              </div>
            </div>
            {provider === "CSV_JSON" && (
              <>
                <div>
                  <label className="text-[12px] text-[var(--text-dim)] block mb-1">CSV 内容</label>
                  <textarea className="input font-mono text-[11px]" rows={6} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="完整导入: name,position,age,height_cm,weight_kg,season,g,mp,pts,reb,ast,stl,blk,tov,fgm,fga,tpm,tpa,ftm,fta,salary,contract_years,draft_year&#10;仅合并合同: name,salary,contract_years" />
                </div>
                <label className="text-[12px] text-[var(--text-dim)] flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={contractOnly} onChange={(e) => setContractOnly(e.target.checked)} />
                  仅合并合同（按球员名匹配更新薪资，不替换联盟 — 适合补全薪资 CSV）
                </label>
              </>
            )}
            <button className="btn btn-primary" onClick={runImport} disabled={busy === "import"}>
              {busy === "import" ? "导入中…" : contractOnly ? "合并合同（保留联盟）" : "执行导入（替换当前阵容数据）"}
            </button>
            <div className="text-[11px] text-[var(--text-dim)]">注意：导入会替换存档中的球队与球员，并按导入统计重新计算可解释评分；赛程保留。也可使用命令行 `npm run import`。</div>
          </div>
        </Section>

        <Section title={`数据来源与更新时间（${sources.length} 条记录）`}>
          <div className="space-y-2">
            {sources.map((s) => (
              <div key={s.id} className="panel-2 p-2.5 text-[12px]">
                <div className="flex items-center gap-2 flex-wrap">
                  <ProvenanceTag source={{ provider: s.provider, sourceUrl: s.sourceUrl, retrievedAt: s.retrievedAt, season: s.season, licenseNote: s.licenseNote, status: s.status as "DEMO", ratingVersion: "" }} />
                  <span className="text-[var(--text-dim)]">{s.records} 条 · 赛季 {s.season ?? "未知"}</span>
                </div>
                <div className="text-[11px] text-[var(--text-dim)] mt-1">
                  更新时间：{s.retrievedAt ? new Date(s.retrievedAt).toLocaleString("zh-CN") : "未知"} · {s.licenseNote}
                </div>
              </div>
            ))}
            {sources.length === 0 && <div className="text-[12px] text-[var(--text-dim)]">暂无数据源记录</div>}
          </div>
        </Section>

        <Section title="规则与评分版本">
          <div className="text-[12px] text-[var(--text-dim)] space-y-1">
            <div>CBA / 薪资规则：{summary.cap.cbaVersion}（工资帽 {CBA.salaryCap}M、税线 {CBA.luxuryTax}M、一/二土豪线 {CBA.firstApron}/{CBA.secondApron}M）</div>
            <div>评分引擎：{summary.save.ratingVersion}（基于统计的可解释评分，非官方评分）</div>
            <div>化学反应：CHEMISTRY v1.0</div>
            <div>比赛/赛季模拟：GAME-SIM v1.0 / SEASON-SIM v1.0（种子 {summary.save.seed}，确定性）</div>
          </div>
        </Section>
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
