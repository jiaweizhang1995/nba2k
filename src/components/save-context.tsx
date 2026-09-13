"use client";

// Shared client state: current save + auto-refresh helper.
// Native React state only — no external state library.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export interface SaveSummary {
  save: {
    id: string;
    name: string;
    season: number;
    phase: string;
    currentDate: string;
    seed: number;
    godMode: boolean;
    dataProvider: string;
    dataStatus: string;
    ruleVersion: string;
    ratingVersion: string;
  };
  userTeam: {
    id: string;
    abbr: string;
    city: string;
    name: string;
    conference: string;
    division: string;
    wins: number;
    losses: number;
  } | null;
  chemistry: { overall: number } | null;
  cap: {
    totalSalary: number;
    capSpace: number;
    overCap: boolean;
    overTax: boolean;
    taxBill: number;
    rosterCount: number;
    cbaVersion: string;
    cap: number;
    tax: number;
    firstApron: number;
    secondApron: number;
  };
}

interface Ctx {
  saveId: string | null;
  summary: SaveSummary | null;
  loading: boolean;
  refresh: () => Promise<void>;
  selectSave: (id: string) => void;
}

const SaveCtx = createContext<Ctx>({
  saveId: null,
  summary: null,
  loading: true,
  refresh: async () => {},
  selectSave: () => {},
});

export function SaveProvider({ children }: { children: React.ReactNode }) {
  const [saveId, setSaveId] = useState<string | null>(null);
  const [summary, setSummary] = useState<SaveSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = window.localStorage.getItem("hwgm:saveId");
    if (stored) setSaveId(stored);
    else setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!saveId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/saves/${saveId}`);
      const json = await res.json();
      if (json.ok) setSummary(json as SaveSummary);
      else setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [saveId]);

  useEffect(() => {
    if (saveId) void refresh();
  }, [saveId, refresh]);

  const selectSave = useCallback((id: string) => {
    window.localStorage.setItem("hwgm:saveId", id);
    setSummary(null);
    setSaveId(id);
  }, []);

  const value = useMemo(() => ({ saveId, summary, loading, refresh, selectSave }), [saveId, summary, loading, refresh, selectSave]);
  return <SaveCtx.Provider value={value}>{children}</SaveCtx.Provider>;
}

export function useSave() {
  return useContext(SaveCtx);
}

/** Tiny fetch wrapper returning parsed json or throwing with the server message. */
export async function api<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.message ?? `请求失败（${res.status}）`);
  return json as T;
}

export const PHASE_LABEL: Record<string, string> = {
  REGULAR_SEASON: "常规赛",
  PLAYOFFS: "季后赛",
  OFFSEASON: "休赛期",
  DRAFT: "选秀大会",
  FREE_AGENCY: "自由市场",
};

export const ROLE_LABEL: Record<string, string> = {
  STAR: "核心",
  STARTER: "首发",
  SIXTH_MAN: "第六人",
  ROTATION: "轮换",
  BENCH: "替补",
  STASH: "储备",
};
