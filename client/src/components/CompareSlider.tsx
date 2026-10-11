import { useState } from "react";
import { useLang } from "../App";

interface CompareSliderProps {
  before: string;
  after: string;
  alt: string;
}

export default function CompareSlider({ before, after, alt }: CompareSliderProps) {
  const { t } = useLang();
  const [pos, setPos] = useState(50);

  return (
    <div>
      <div className="relative aspect-[4/5] w-full select-none overflow-hidden rounded-xl bg-slate-200">
        {/* Before (original) — full layer */}
        <img
          src={before}
          alt={alt}
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        />
        {/* After (processed) — clipped from the left */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        >
          <img
            src={after}
            alt={alt}
            draggable={false}
            className="h-full w-full object-cover"
          />
        </div>
        {/* Divider */}
        <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%` }}>
          <div className="h-full w-0.5 -translate-x-1/2 bg-white shadow-[0_0_6px_rgba(0,0,0,0.5)]" />
          <div className="absolute top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90 shadow">
            <svg viewBox="0 0 24 24" className="h-full w-full p-1.5 text-slate-700" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
            </svg>
          </div>
        </div>
        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
          {t.after}
        </span>
        <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
          {t.before}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label={`${t.before} / ${t.after}`}
        className="mt-3 w-full accent-indigo-600"
      />
    </div>
  );
}
