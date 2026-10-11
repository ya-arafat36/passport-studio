import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { STR, type Lang } from "./i18n";
import {
  createJob,
  deletePhoto,
  exportPdf,
  getConfig,
  getHealth,
  getJob,
  reprocessPhoto,
  uploadFiles,
  type ConfigResp,
  type CropBox,
  type JobPayload,
  type JobStatus,
  type UploadPhoto,
} from "./api";
import Dropzone from "./components/Dropzone";
import PhotoGrid, { ResultCard } from "./components/PhotoGrid";
import SettingsPanel, { DEFAULT_SETTINGS, type Settings } from "./components/SettingsPanel";
import ProgressBar from "./components/ProgressBar";
import CropEditor from "./components/CropEditor";
import SheetPreview from "./components/SheetPreview";
import ErrorBanner, { type BannerItem } from "./components/ErrorBanner";
import LangToggle from "./components/LangToggle";

// ---- i18n context -----------------------------------------------------------

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (typeof STR)["en"];
}

const LangContext = createContext<LangCtx | null>(null);

export function useLang(): LangCtx {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used inside <App>");
  return ctx;
}

interface Alert {
  id: string;
  message: string;
}

function Shell() {
  const { t } = useLang();

  const [config, setConfig] = useState<ConfigResp | null>(null);
  const [photos, setPhotos] = useState<UploadPhoto[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [jobSettings, setJobSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [jobRunning, setJobRunning] = useState(false);
  const [cropOverrides, setCropOverrides] = useState<Record<string, CropBox>>({});
  const [cropTarget, setCropTarget] = useState<UploadPhoto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reprocessingIds, setReprocessingIds] = useState<Set<string>>(new Set());
  const [previewBust, setPreviewBust] = useState<Record<string, number>>({});
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const pollRef = useRef<number | null>(null);
  const stopPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => () => stopPoll(), [stopPoll]);

  const addAlert = useCallback((message: string) => {
    setAlerts((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, message }]);
  }, []);
  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ---- initial load ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getHealth();
        const cfg = await getConfig();
        if (!cancelled) setConfig(cfg);
      } catch (e) {
        if (!cancelled) addAlert(`${t.loadFailed} ${e instanceof Error ? e.message : ""}`.trim());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addAlert, t.loadFailed]);

  // ---- uploads --------------------------------------------------------------
  const handleUploaded = useCallback(
    (uploaded: UploadPhoto[], duplicateCount: number) => {
      setPhotos((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = uploaded.filter((p) => !seen.has(p.id));
        return [...prev, ...fresh];
      });
      if (duplicateCount > 0) addAlert(t.duplicateNote);
      for (const p of uploaded) {
        if (p.status === "failed" && p.error) addAlert(`${t.uploadFailed}: ${p.filename} — ${p.error}`);
      }
    },
    [addAlert, t]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await deletePhoto(id);
        setPhotos((prev) => prev.filter((p) => p.id !== id));
        setCropOverrides((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } catch (e) {
        addAlert(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [addAlert]
  );

  const handleReplace = useCallback(
    async (id: string, file: File) => {
      setBusyId(id);
      try {
        await deletePhoto(id);
        const { photos: uploaded } = await uploadFiles([file]);
        const replacement = uploaded[0];
        if (replacement) {
          setPhotos((prev) => prev.map((p) => (p.id === id ? replacement : p)));
        } else {
          setPhotos((prev) => prev.filter((p) => p.id !== id));
        }
      } catch (e) {
        addAlert(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [addAlert]
  );

  // ---- jobs -----------------------------------------------------------------
  const startJob = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0 || jobRunning) return;
      setJobRunning(true);
      setJob(null);
      try {
        const payload: JobPayload = {
          photoIds: ids,
          background: {
            preset: settings.bgPreset,
            ...(settings.bgPreset === "custom" ? { color: settings.customColor } : {}),
          },
          enhance: settings.enhance,
          copiesPerPhoto: settings.copiesPerPhoto,
          marginsMm: { ...settings.marginsMm },
          cutMarks: settings.cutMarks,
          ...(Object.keys(cropOverrides).length > 0 ? { cropOverrides: { ...cropOverrides } } : {}),
        };
        const created = await createJob(payload);
        setJobSettings({ ...settings });
        stopPoll();
        pollRef.current = window.setInterval(async () => {
          try {
            const s = await getJob(created.id);
            setJob(s);
            if (s.status === "done" || s.status === "failed") {
              stopPoll();
              setJobRunning(false);
              // Bust <img> caches so re-processed photos always show the
              // fresh result, never a stale browser-cached image.
              if (s.status === "done") {
                const ts = Date.now();
                setPreviewBust((prev) => {
                  const next = { ...prev };
                  for (const item of s.items ?? []) {
                    if (item.status === "done") next[item.photoId] = ts;
                  }
                  return next;
                });
              }
            }
          } catch (e) {
            stopPoll();
            setJobRunning(false);
            addAlert(`${t.jobFailed}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }, 1500);
      } catch (e) {
        setJobRunning(false);
        addAlert(`${t.jobFailed}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [jobRunning, settings, cropOverrides, stopPoll, addAlert, t]
  );

  // ---- single-photo reprocess (Adjust crop on an already-processed photo) ---
  // Saves the crop AND immediately reprocesses just that photo in place, so
  // the user sees their manual crop applied right away — no extra clicks.
  const reprocessOne = useCallback(
    async (photoId: string, box: CropBox) => {
      setReprocessingIds((prev) => new Set(prev).add(photoId));
      try {
        const base = job ? jobSettings : settings;
        await reprocessPhoto(photoId, {
          cropOverride: box,
          background: {
            preset: base.bgPreset,
            ...(base.bgPreset === "custom" ? { color: base.customColor } : {}),
          },
          enhance: base.enhance,
        });
        // Bust the <img> cache so the CompareSlider shows the new image.
        setPreviewBust((prev) => ({ ...prev, [photoId]: Date.now() }));
      } catch (e) {
        addAlert(`${t.jobFailed}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setReprocessingIds((prev) => {
          const next = new Set(prev);
          next.delete(photoId);
          return next;
        });
      }
    },
    [job, jobSettings, settings, addAlert, t]
  );

  const processableIds = photos.filter((p) => p.status !== "failed").map((p) => p.id);

  const failedItemIds = (job?.items ?? [])
    .filter((i) => i.status === "failed")
    .map((i) => i.photoId);

  // ---- export ---------------------------------------------------------------
  const handleExport = useCallback(async () => {
    if (!job || exporting) return;
    setExporting(true);
    try {
      const { blob, filename } = await exportPdf(job.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportNote(t.downloadStarted);
      window.setTimeout(() => setExportNote(null), 4000);
    } catch (e) {
      addAlert(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [job, exporting, addAlert, t]);

  // ---- banners --------------------------------------------------------------
  const bannerItems: BannerItem[] = [
    ...(config && config.bgProvider === "none"
      ? [{ id: "bg-none", message: t.bgNotConfigured, kind: "warning" as const }]
      : []),
    ...alerts.map((a) => ({
      id: a.id,
      message: a.message,
      kind: "error" as const,
      onDismiss: () => dismissAlert(a.id),
    })),
    ...(job && (job.status === "done" || job.status === "failed") && job.failed > 0
      ? [
          {
            id: "job-failed",
            message: `${t.jobFailed}: ${failedItemIds
              .map((id) => job.items.find((i) => i.id === id)?.filename ?? id)
              .join(", ")}`,
            kind: "error" as const,
            retryable: true,
            onRetry: () => void startJob(failedItemIds),
            onDismiss: undefined,
          },
        ]
      : []),
  ];

  const doneItems = (job?.items ?? []).filter((i) => i.status === "done");
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const donePhotos = doneItems
    .map((i) => photoById.get(i.photoId))
    .filter((p): p is UploadPhoto => p !== undefined);

  const canExport = job?.status === "done" && donePhotos.length > 0;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{t.title}</h1>
            <p className="text-sm text-slate-500">{t.subtitle}</p>
          </div>
          <LangToggle />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
        <ErrorBanner items={bannerItems} />

        {/* Upload */}
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <Dropzone
            onUploaded={handleUploaded}
            onError={(msg) => addAlert(`${t.uploadFailed}: ${msg}`)}
          />
        </section>

        {/* Photo grid */}
        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">
            {t.photosTitle}
            {photos.length > 0 && <span className="ml-2 text-sm font-normal text-slate-500">({photos.length})</span>}
          </h2>
          <PhotoGrid
            photos={photos}
            jobItems={job?.items ?? []}
            onRemove={(id) => void handleRemove(id)}
            onReplace={(id, file) => void handleReplace(id, file)}
            busyId={busyId}
          />
        </section>

        {/* Settings */}
        <SettingsPanel settings={settings} onChange={setSettings} />

        {/* Process */}
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={photos.length === 0 || jobRunning}
              onClick={() => void startJob(processableIds)}
              className="rounded-xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white shadow hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {jobRunning ? t.processing : t.processAll}
            </button>
            {jobRunning && <span className="text-sm text-slate-500">{t.jobStarting}</span>}
          </div>
          {job && (
            <ProgressBar
              total={job.total}
              processed={job.processed}
              failed={job.failed}
              remaining={job.remaining}
              active={jobRunning}
            />
          )}
        </section>

        {/* Results */}
        {donePhotos.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold text-slate-900">{t.resultsTitle}</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {donePhotos.map((p) => (
                <ResultCard
                  key={p.id}
                  photo={p}
                  onAdjustCrop={setCropTarget}
                  hasCustomCrop={!!cropOverrides[p.id]}
                  reprocessing={reprocessingIds.has(p.id)}
                  bust={previewBust[p.id]}
                />
              ))}
            </div>
          </section>
        )}

        {/* Sheet preview */}
        {donePhotos.length > 0 && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <h2 className="mb-4 text-lg font-semibold text-slate-900">{t.sheetTitle}</h2>
            <SheetPreview
              photoIds={donePhotos.map((p) => p.id)}
              copiesPerPhoto={jobSettings.copiesPerPhoto}
              marginsMm={jobSettings.marginsMm}
              bust={previewBust}
            />
          </section>
        )}

        {/* Export */}
        {job && (
          <section className="flex items-center gap-3">
            <button
              type="button"
              disabled={!canExport || exporting}
              onClick={() => void handleExport()}
              className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-bold text-white shadow hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exporting ? t.exporting : t.exportPdf}
            </button>
            {exportNote && <span className="text-sm text-emerald-700">{exportNote}</span>}
          </section>
        )}
      </main>

      {/* Crop editor modal */}
      {cropTarget && (
        <CropEditor
          photoId={cropTarget.id}
          filename={cropTarget.filename}
          origWidth={cropTarget.width}
          origHeight={cropTarget.height}
          initial={cropOverrides[cropTarget.id]}
          onSave={(photoId, box) => {
            setCropOverrides((prev) => ({ ...prev, [photoId]: box }));
            setCropTarget(null);
            // If this photo was already processed, reprocess it immediately
            // so the manual crop visibly applies (no extra clicks needed).
            if (donePhotos.some((p) => p.id === photoId)) {
              void reprocessOne(photoId, box);
            }
          }}
          onClose={() => setCropTarget(null)}
        />
      )}
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>("en");
  const value: LangCtx = { lang, setLang, t: STR[lang] };
  return (
    <LangContext.Provider value={value}>
      <Shell />
    </LangContext.Provider>
  );
}
