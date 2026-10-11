import { useLang } from "../App";

export default function LangToggle() {
  const { lang, setLang } = useLang();
  const base =
    "px-3 py-1.5 text-sm font-medium transition-colors";
  return (
    <div className="flex overflow-hidden rounded-lg border border-slate-300 bg-white">
      <button
        type="button"
        aria-pressed={lang === "en"}
        onClick={() => setLang("en")}
        className={`${base} ${lang === "en" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
      >
        EN
      </button>
      <button
        type="button"
        aria-pressed={lang === "bn"}
        onClick={() => setLang("bn")}
        className={`${base} ${lang === "bn" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
      >
        বাংলা
      </button>
    </div>
  );
}
