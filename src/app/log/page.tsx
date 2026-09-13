"use client";

// Audit log: every normal + God Mode operation, filterable.

import { useCallback, useEffect, useState } from "react";
import { api, useSave } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface EventRow {
  id: string;
  at: string;
  category: string;
  godMode: boolean;
  actor: string;
  message: string;
}

const CAT_LABEL: Record<string, string> = {
  SYSTEM: "系统",
  SIM: "模拟",
  TRADE: "交易",
  DRAFT: "选秀",
  FA: "自由市场",
  GOD: "GOD",
  AI: "AI",
  NEWS: "新闻",
};
const CAT_COLOR: Record<string, string> = {
  SYSTEM: "var(--text-dim)",
  SIM: "var(--accent)",
  TRADE: "var(--good)",
  DRAFT: "#a78bfa",
  FA: "var(--warn)",
  GOD: "var(--bad)",
  AI: "#34d399",
};

export default function LogPage() {
  const { saveId } = useSave();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [cat, setCat] = useState("ALL");
  const [godOnly, setGodOnly] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const load = useCallback(async () => {
    if (!saveId) return;
    try {
      const j = await api<{ events: EventRow[] }>(`/api/saves/${saveId}/events?limit=300`);
      setEvents(j.events);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  }, [saveId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!saveId) return <div className="text-[13px] text-[var(--text-dim)] p-4">未选择存档</div>;

  const filtered = events.filter((e) => (cat === "ALL" || e.category === cat) && (!godOnly || e.godMode));

  return (
    <div className="space-y-4">
      <Section
        title={`操作日志（${filtered.length} 条）`}
        right={
          <div className="flex gap-2 items-center flex-wrap">
            <select className="input max-w-40" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="ALL">全部类别</option>
              {Object.keys(CAT_LABEL).map((c) => (
                <option key={c} value={c}>
                  {CAT_LABEL[c]}
                </option>
              ))}
            </select>
            <label className="text-[12px] text-[var(--text-dim)] flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={godOnly} onChange={(e) => setGodOnly(e.target.checked)} />
              仅 GOD MODE
            </label>
            <button className="btn" onClick={load}>
              刷新
            </button>
          </div>
        }
      >
        <div className="scrollbox max-h-[640px]">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 150 }}>时间</th>
                <th style={{ width: 90 }}>类别</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} style={e.godMode ? { background: "#1f1216" } : undefined}>
                  <td className="text-[var(--text-dim)] text-[12px]">{new Date(e.at).toLocaleString("zh-CN", { hour12: false })}</td>
                  <td>
                    <span className="tag" style={{ color: CAT_COLOR[e.category] ?? undefined }}>
                      {CAT_LABEL[e.category] ?? e.category}
                      {e.godMode ? " ⚡" : ""}
                    </span>
                  </td>
                  <td className="text-[12px] whitespace-normal">{e.message}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-center text-[var(--text-dim)] py-6">
                    暂无日志
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
