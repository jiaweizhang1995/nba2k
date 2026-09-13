"use client";

// Small shared UI atoms.

import { useMemo, useState } from "react";
import type { PlayerSource } from "@/domain/types";

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="panel p-3 md:p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-[13px] font-semibold text-[var(--text-dim)] tracking-wide">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function RatingBar({ label, value }: { label: string; value: number | null }) {
  const color = value == null ? "#334155" : value >= 80 ? "#34d399" : value >= 65 ? "#38bdf8" : value >= 50 ? "#fbbf24" : "#f87171";
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-14 text-[var(--text-dim)] shrink-0">{label}</span>
      <div className="bar flex-1">
        <div style={{ width: `${value ?? 0}%`, background: color }} />
      </div>
      <span className="w-8 text-right tabular-nums">{value ?? "?"}</span>
    </div>
  );
}

export function ProvenanceTag({ source }: { source: PlayerSource | null | undefined }) {
  if (!source) return <span className="tag">来源未知</span>;
  const cls = source.status === "DEMO" ? "tag-demo" : source.status === "IMPORTED" ? "tag-imported" : "";
  const label = source.status === "DEMO" ? "DEMO 数据" : source.status === "IMPORTED" ? `IMPORTED · ${source.provider}` : "来源未知";
  return (
    <span className={`tag ${cls}`} title={`${source.provider}\n${source.sourceUrl ?? "无来源URL"}\n获取时间: ${source.retrievedAt ?? "未知"}\n赛季: ${source.season ?? "未知"}\n授权: ${source.licenseNote}`}>
      {label}
    </span>
  );
}

/** Sortable, filterable data table. */
export function DataTable<T extends Record<string, unknown>>({
  rows,
  columns,
  initialSort,
  filterKeys,
  rowKey,
  onRowClick,
  maxHeight,
}: {
  rows: T[];
  columns: { key: string; label: string; render?: (row: T) => React.ReactNode; align?: "left" | "right"; sortable?: boolean }[];
  initialSort?: { key: string; dir: "asc" | "desc" };
  filterKeys?: (keyof T & string)[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  maxHeight?: number;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    let out = rows;
    if (q && filterKeys?.length) {
      const needle = q.toLowerCase();
      out = out.filter((r) => filterKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(needle)));
    }
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
      });
    }
    return out;
  }, [rows, q, sort, filterKeys]);

  return (
    <div>
      {filterKeys?.length ? (
        <input className="input mb-2 max-w-64" placeholder="筛选…" value={q} onChange={(e) => setQ(e.target.value)} />
      ) : null}
      <div className="scrollbox" style={maxHeight ? { maxHeight } : undefined}>
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ textAlign: c.align ?? "left", cursor: c.sortable === false ? "default" : "pointer" }}
                  onClick={() =>
                    c.sortable === false
                      ? undefined
                      : setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: "desc" }))
                  }
                >
                  {c.label}
                  {sort?.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} style={{ cursor: onRowClick ? "pointer" : undefined }}>
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? "left" }}>
                    {c.render ? c.render(r) : String(r[c.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="text-center text-[var(--text-dim)] py-6">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Toast({ message, kind }: { message: string; kind: "ok" | "err" | "info" }) {
  const bg = kind === "ok" ? "#052e16" : kind === "err" ? "#450a0a" : "#0c2a45";
  const border = kind === "ok" ? "#15803d" : kind === "err" ? "#b91c1c" : "#1d4ed8";
  return (
    <div className="fixed bottom-4 right-4 z-50 text-[13px] px-4 py-2.5 rounded-md border shadow-lg max-w-md" style={{ background: bg, borderColor: border }}>
      {message}
    </div>
  );
}

export function fmtSalary(v: number | null | undefined): string {
  // 0 / null = salary not present in the source data → show 未知, never 0.0M
  if (v == null || v === 0) return "未知";
  return `${v.toFixed(1)}M`;
}

export function fmtAvg(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}
