"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, useSave } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface SaveRow {
  id: string;
  name: string;
  season: number;
  phase: string;
  godMode: boolean;
  dataProvider: string;
  dataStatus: string;
  seed: number;
  createdAt: string;
}

export default function HomePage() {
  const { selectSave, saveId } = useSave();
  const router = useRouter();
  const [saves, setSaves] = useState<SaveRow[]>([]);
  const [name, setName] = useState("我的王朝");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  useEffect(() => {
    api<{ saves: SaveRow[] }>("/api/saves")
      .then((j) => {
        setSaves(j.saves);
        // First visit: jump straight into the default (real-data) save.
        const stored = window.localStorage.getItem("hwgm:saveId");
        if (!stored && j.saves.length > 0) {
          selectSave(j.saves[0].id);
          router.push("/gm");
        }
      })
      .catch(() => setSaves([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const j = await api<{ saveId: string }>("/api/saves", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      router.push(`/setup/${j.saveId}`);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    if (!window.confirm("确认删除该存档？此操作不可恢复。")) return;
    try {
      await api(`/api/saves/${id}`, { method: "DELETE" });
      setSaves((s) => s.filter((x) => x.id !== id));
      if (saveId === id) {
        window.localStorage.removeItem("hwgm:saveId");
        router.push("/");
      }
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
    }
  };

  return (
    <div className="grid md:grid-cols-2 gap-4 items-start">
      <Section title="新建存档">
        <div className="space-y-3">
          <div>
            <label className="text-[12px] text-[var(--text-dim)] block mb-1">存档名称</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </div>
          <div className="text-[12px] text-[#86efac] bg-[#052e16] border border-[#166534] rounded p-2.5 leading-relaxed">
            新存档默认使用内置 <b>真实 NBA 2026-27</b> 数据：30 支真实球队、539 名真实球员（真实名单、
            统计与合同，来源 Wikipedia · CC BY-SA 4.0 / ESPN 公开数据）。数据溯源见「设置 → 数据来源」。
          </div>
          <button className="btn btn-primary w-full" onClick={create} disabled={busy}>
            {busy ? "生成联盟中…" : "创建存档并选择球队"}
          </button>
        </div>
      </Section>

      <Section title="继续游戏">
        <div className="space-y-2">
          {saves.length === 0 && <div className="text-[13px] text-[var(--text-dim)] py-4">还没有存档，先在左侧创建一个。</div>}
          {saves.map((s) => (
            <div key={s.id} className="panel-2 px-3 py-2.5 flex items-center gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold truncate">
                  {s.name} <span className="tag ml-1">{s.dataStatus === "DEMO" ? "DEMO 数据" : "真实 NBA 数据"}</span>
                  {s.godMode && <span className="tag tag-god ml-1">GOD</span>}
                </div>
                <div className="text-[11px] text-[var(--text-dim)] mt-0.5">
                  赛季 {s.season - 1}-{String(s.season).slice(2)} · 种子 {s.seed} · 创建于 {new Date(s.createdAt).toLocaleString("zh-CN")}
                </div>
              </div>
              <button
                className="btn btn-primary"
                onClick={() => {
                  selectSave(s.id);
                  router.push("/gm");
                }}
              >
                进入
              </button>
              <button className="btn btn-danger" onClick={() => del(s.id)}>
                删除
              </button>
            </div>
          ))}
        </div>
      </Section>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}
