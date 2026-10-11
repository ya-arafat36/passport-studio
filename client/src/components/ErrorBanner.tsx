import { useLang } from "../App";

export interface BannerItem {
  id: string;
  message: string;
  kind: "error" | "warning";
  retryable?: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export default function ErrorBanner({ items }: { items: BannerItem[] }) {
  const { t } = useLang();
  if (items.length === 0) return null;
  return (
    <div className="space-y-2" role="alert">
      {items.map((item) => (
        <div
          key={item.id}
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
            item.kind === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          <svg
            className="mt-0.5 h-5 w-5 shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm-1-5a1 1 0 112 0 1 1 0 01-2 0zm1-8a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-line break-words">{item.message}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            {item.retryable && item.onRetry && (
              <button
                type="button"
                onClick={item.onRetry}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
              >
                {t.retry}
              </button>
            )}
            {item.onDismiss && (
              <button
                type="button"
                onClick={item.onDismiss}
                className="rounded-lg border border-current px-3 py-1.5 text-xs font-semibold hover:bg-black/5"
              >
                {t.dismiss}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
