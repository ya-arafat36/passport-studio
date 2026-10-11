import { useCallback, useRef, useState } from "react";
import { useLang } from "../App";
import { uploadFiles, type UploadPhoto } from "../api";

interface DropzoneProps {
  onUploaded: (photos: UploadPhoto[], duplicateCount: number) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

export default function Dropzone({ onUploaded, onError, disabled }: DropzoneProps) {
  const { t } = useLang();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lastCount, setLastCount] = useState(0);

  const doUpload = useCallback(
    async (files: File[] | FileList) => {
      if (uploading || disabled) return;
      const list = Array.from(files);
      if (list.length === 0) return;
      setUploading(true);
      setLastCount(list.length);
      try {
        const { photos } = await uploadFiles(list);
        const dups = photos.filter((p) => p.status === "duplicate").length;
        onUploaded(photos, dups);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [uploading, disabled, onUploaded, onError]
  );

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label={t.dropTitle}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void doUpload(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? "border-indigo-500 bg-indigo-50"
            : "border-slate-300 bg-white hover:border-indigo-400 hover:bg-indigo-50/40"
        } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <svg className="mb-3 h-10 w-10 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0-12L8 8m4-4l4 4" />
        </svg>
        <p className="text-base font-semibold text-slate-800">{dragging ? t.dropActive : t.dropTitle}</p>
        <p className="mt-1 text-sm text-slate-500">{t.dropSub}</p>
        <p className="mt-2 text-xs text-slate-400">{t.acceptHint}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/jpeg,image/jpg,image/png,image/webp,.pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void doUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {uploading && (
        <p className="mt-2 text-sm text-slate-500">
          {t.uploading} ({lastCount})
        </p>
      )}
    </div>
  );
}
