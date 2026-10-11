import { useLang } from "../App";

interface ProgressBarProps {
  total: number;
  processed: number;
  failed: number;
  remaining: number;
  active: boolean;
}

export default function ProgressBar({ total, processed, failed, remaining, active }: ProgressBarProps) {
  const { t } = useLang();
  const pct = total > 0 ? Math.round(((processed + failed) / total) * 100) : 0;
  const counters = [
    { label: t.total, value: total, cls: "text-slate-700" },
    { label: t.processed, value: processed, cls: "text-emerald-600" },
    { label: t.failed, value: failed, cls: "text-red-600" },
    { label: t.remaining, value: remaining, cls: "text-amber-600" },
  ];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-all duration-500 ${active ? "bg-indigo-600" : "bg-indigo-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {counters.map((c) => (
          <div key={c.label} className="rounded-lg bg-slate-50 px-3 py-2 text-center">
            <div className={`text-lg font-bold ${c.cls}`}>{c.value}</div>
            <div className="text-xs text-slate-500">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
