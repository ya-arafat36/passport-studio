import { useLang } from "../App";
import type { BgPreset, MarginsMm } from "../api";

export interface Settings {
  bgPreset: BgPreset;
  customColor: string;
  enhance: boolean;
  copiesPerPhoto: number;
  marginsMm: MarginsMm;
  cutMarks: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  bgPreset: "white",
  customColor: "#00a86b",
  enhance: true,
  copiesPerPhoto: 1,
  marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
  cutMarks: false,
};

interface SettingsPanelProps {
  settings: Settings;
  onChange: (s: Settings) => void;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-indigo-600" : "bg-slate-300"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`}
      />
    </button>
  );
}

export default function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const { t } = useLang();
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });
  const setMargin = (key: keyof MarginsMm, value: number) =>
    onChange({ ...settings, marginsMm: { ...settings.marginsMm, [key]: value } });

  const marginKeys: { key: keyof MarginsMm; label: string }[] = [
    { key: "top", label: t.mTop },
    { key: "right", label: t.mRight },
    { key: "bottom", label: t.mBottom },
    { key: "left", label: t.mLeft },
  ];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <h2 className="mb-4 text-lg font-semibold text-slate-900">{t.settingsTitle}</h2>
      <div className="grid gap-6 md:grid-cols-2">
        {/* Background */}
        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">{t.bgLabel}</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { preset: "white" as BgPreset, label: t.bgWhite, swatch: "#ffffff", ring: true },
                { preset: "blue" as BgPreset, label: t.bgBlue, swatch: "#2b6cb0", ring: false },
                { preset: "custom" as BgPreset, label: t.bgCustom, swatch: settings.customColor, ring: true },
              ]
            ).map((opt) => (
              <label
                key={opt.preset}
                className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                  settings.bgPreset === opt.preset
                    ? "border-indigo-600 bg-indigo-50 ring-1 ring-indigo-600"
                    : "border-slate-300 hover:border-slate-400"
                }`}
              >
                <input
                  type="radio"
                  name="bg-preset"
                  checked={settings.bgPreset === opt.preset}
                  onChange={() => set("bgPreset", opt.preset)}
                  className="accent-indigo-600"
                />
                <span
                  className={`inline-block h-5 w-5 rounded ${opt.ring ? "border border-slate-300" : ""}`}
                  style={{ backgroundColor: opt.swatch }}
                />
                {opt.label}
              </label>
            ))}
          </div>
          {settings.bgPreset === "custom" && (
            <div className="mt-3 flex items-center gap-2">
              <input
                type="color"
                value={settings.customColor}
                onChange={(e) => set("customColor", e.target.value)}
                aria-label={t.customColor}
                className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white p-1"
              />
              <input
                type="text"
                value={settings.customColor}
                onChange={(e) => set("customColor", e.target.value)}
                className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </div>
          )}
        </div>

        {/* Enhance + cut marks + copies */}
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-slate-700">{t.enhanceLabel}</span>
            <Toggle checked={settings.enhance} onChange={(v) => set("enhance", v)} label={t.enhanceLabel} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-slate-700">{t.cutMarksLabel}</span>
            <Toggle checked={settings.cutMarks} onChange={(v) => set("cutMarks", v)} label={t.cutMarksLabel} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="copies" className="text-sm font-medium text-slate-700">
              {t.copiesLabel}
            </label>
            <input
              id="copies"
              type="number"
              min={1}
              max={10}
              value={settings.copiesPerPhoto}
              onChange={(e) => {
                const v = Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1)));
                set("copiesPerPhoto", v);
              }}
              className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-center"
            />
          </div>
        </div>

        {/* Photo size (static) */}
        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">{t.sizeLabel}</p>
          <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-700">{t.sizeStatic}</p>
        </div>

        {/* Margins */}
        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">{t.marginsLabel}</p>
          <div className="grid grid-cols-4 gap-2">
            {marginKeys.map(({ key, label }) => (
              <label key={key} className="block">
                <span className="mb-1 block text-xs text-slate-500">{label}</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={0.5}
                  value={settings.marginsMm[key]}
                  onChange={(e) => setMargin(key, Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-center"
                />
              </label>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
