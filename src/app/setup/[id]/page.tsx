"use client";

// Post-creation setup: choose the franchise to control.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, useSave } from "@/components/save-context";
import { Section, Toast } from "@/components/ui";

interface TeamRow {
  id: string;
  abbr: string;
  city: string;
  name: string;
  conference: string;
  division: string;
  aiPhase: string;
  cap: { totalSalary: number };
  rosterSize: number;
}

const PHASE_DESC: Record<string, string> = {
  CONTENDER: "争冠窗口，赢在当下",
  PLAYOFF: "季后赛行列",
  BUBBLE: "附加赛边缘",
  REBUILD: "重建期，囤积资产",
};

export default function SetupPage() {
  const params = useParams<{ id: string }>();
  const saveId = params.id;
  const router = useRouter();
  const { selectSave } = useSave();
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  useEffect(() => {
    selectSave(saveId);
    api<{ teams: TeamRow[] }>(`/api/saves/${saveId}/teams`)
      .then((j) => setTeams(j.teams))
      .catch((e) => setToast({ msg: (e as Error).message, kind: "err" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId]);

  const choose = async (teamId: string) => {
    setBusy(teamId);
    try {
      await api(`/api/saves/${saveId}`, { method: "PATCH", body: JSON.stringify({ teamId }) });
      router.push("/gm");
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "err" });
      setBusy(null);
    }
  };

  const byConf = (c: string) => teams.filter((t) => t.conference === c);

  return (
    <div className="space-y-4">
      <Section title="选择你的球队（ 东部 ）">
        <div className="grid md:grid-cols-3 gap-2">
          {byConf("EAST").map((t) => (
            <TeamCard key={t.id} t={t} busy={busy === t.id} onChoose={() => choose(t.id)} />
          ))}
        </div>
      </Section>
      <Section title="选择你的球队（ 西部 ）">
        <div className="grid md:grid-cols-3 gap-2">
          {byConf("WEST").map((t) => (
            <TeamCard key={t.id} t={t} busy={busy === t.id} onChoose={() => choose(t.id)} />
          ))}
        </div>
      </Section>
      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}

function TeamCard({ t, busy, onChoose }: { t: TeamRow; busy: boolean; onChoose: () => void }) {
  return (
    <div className="panel-2 p-3">
      <div className="font-semibold text-[14px]">
        {t.city} {t.name}
        <span className="tag ml-2">{t.abbr}</span>
      </div>
      <div className="text-[11px] text-[var(--text-dim)] mt-1">{t.division}分区</div>
      <div className="text-[11px] mt-1 text-[var(--warn)]">{PHASE_DESC[t.aiPhase] ?? t.aiPhase}</div>
      <div className="text-[11px] text-[var(--text-dim)] mt-1">
        总薪资 {t.cap.totalSalary.toFixed(1)}M · 阵容 {t.rosterSize} 人
      </div>
      <button className="btn btn-primary mt-2 w-full" onClick={onChoose} disabled={busy}>
        {busy ? "加入中…" : "执教这支球队"}
      </button>
    </div>
  );
}
