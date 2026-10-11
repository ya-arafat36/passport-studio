import { useRef } from "react";
import { useLang } from "../App";
import { photoUrl, type JobItem, type UploadPhoto } from "../api";
import { STR } from "../i18n";
import CompareSlider from "./CompareSlider";

type TStrings = (typeof STR)["en"];

function statusStyle(status: string): string {
  switch (status.toLowerCase()) {
    case "done":
    case "uploaded":
      return "bg-emerald-100 text-emerald-700";
    case "processing":
      return "bg-indigo-100 text-indigo-700";
    case "duplicate":
    case "queued":
      return "bg-slate-200 text-slate-700";
    case "failed":
      return "bg-red-100 text-red-700";
    default:
      return "bg-slate-200 text-slate-700";
  }
}

function statusLabel(status: string, t: TStrings): string {
  switch (status.toLowerCase()) {
    case "uploaded":
      return t.stUploaded;
    case "duplicate":
      return t.stDuplicate;
    case "processing":
      return t.stProcessing;
    case "queued":
      return t.stQueued;
    case "done":
      return t.stDone;
    case "failed":
      return t.stFailed;
    default:
      return status;
  }
}

interface PhotoCardProps {
  photo: UploadPhoto;
  jobStatus?: string;
  jobError?: string;
  onRemove: (id: string) => void;
  onReplace: (id: string, file: File) => void;
  busy: boolean;
}

export function PhotoCard({ photo, jobStatus, jobError, onRemove, onReplace, busy }: PhotoCardProps) {
  const { t } = useLang();
  const replaceRef = useRef<HTMLInputElement>(null);
  const badge = jobStatus ?? photo.status;

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="relative aspect-square bg-slate-100">
        <img
          src={photoUrl(photo.id, "original")}
          alt={photo.filename}
          loading="lazy"
          className="h-full w-full object-contain"
        />
        <span
          className={`absolute left-2 top-2 rounded-md px-2 py-0.5 text-xs font-semibold ${statusStyle(badge)}`}
        >
          {statusLabel(badge, t)}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="truncate text-sm font-medium text-slate-800" title={photo.filename}>
          {photo.filename}
        </p>
        <p className="text-xs text-slate-500">
          {photo.width} × {photo.height} px
        </p>
        {(jobError || (photo.error && photo.status === "failed")) && (
          <p className="text-xs text-red-600">{jobError ?? photo.error}</p>
        )}
        <div className="mt-auto flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => replaceRef.current?.click()}
            className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {busy ? t.removing : t.replace}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRemove(photo.id)}
            className="flex-1 rounded-lg border border-red-200 px-2 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {busy ? t.removing : t.remove}
          </button>
        </div>
        <input
          ref={replaceRef}
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/webp,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onReplace(photo.id, f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

interface PhotoGridProps {
  photos: UploadPhoto[];
  jobItems: JobItem[];
  onRemove: (id: string) => void;
  onReplace: (id: string, file: File) => void;
  busyId: string | null;
}

export default function PhotoGrid({ photos, jobItems, onRemove, onReplace, busyId }: PhotoGridProps) {
  const { t } = useLang();
  const itemByPhoto = new Map(jobItems.map((i) => [i.photoId, i]));

  if (photos.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-400">{t.emptyPhotos}</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {photos.map((p) => (
        <PhotoCard
          key={p.id}
          photo={p}
          jobStatus={itemByPhoto.get(p.id)?.status}
          jobError={itemByPhoto.get(p.id)?.error}
          onRemove={onRemove}
          onReplace={onReplace}
          busy={busyId === p.id}
        />
      ))}
    </div>
  );
}

interface ResultCardProps {
  photo: UploadPhoto;
  onAdjustCrop: (photo: UploadPhoto) => void;
  hasCustomCrop?: boolean;
  reprocessing?: boolean;
  bust?: number;
}

export function ResultCard({ photo, onAdjustCrop, hasCustomCrop, reprocessing, bust }: ResultCardProps) {
  const { t } = useLang();
  const afterUrl = photoUrl(photo.id, "processed") + (bust ? `&t=${bust}` : "");
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <CompareSlider
        before={photoUrl(photo.id, "original")}
        after={afterUrl}
        alt={photo.filename}
      />
      {reprocessing && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-white/70">
          <span className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow">
            {t.reprocessing}
          </span>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-slate-800" title={photo.filename}>
          {photo.filename}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {hasCustomCrop && (
            <span className="rounded-md bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800">
              {t.customCrop}
            </span>
          )}
          <button
            type="button"
            onClick={() => onAdjustCrop(photo)}
            disabled={reprocessing}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t.adjustCrop}
          </button>
        </div>
      </div>
    </div>
  );
}
