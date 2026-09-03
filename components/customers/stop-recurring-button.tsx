"use client";

import { useRef, useState, useTransition } from "react";
import { CircleOff } from "lucide-react";
import { stopRecurringBilling } from "@/app/(app)/customers/actions";

// "הפסקת חיוב חודשי" — stops all FUTURE automatic payments for this
// purchase. Never touches any existing Purchase/Payment history (see
// stopRecurringBilling's own comment). Confirmation is required
// because this affects future revenue, matching this app's other
// consequential-action pattern (see components/leads/delete-lead-button.tsx)
// — never a plain browser confirm().
export function StopRecurringButton({
  purchaseId,
  customerId,
  serviceLabel,
}: {
  purchaseId: string;
  customerId: string;
  serviceLabel: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await stopRecurringBilling(purchaseId, customerId);
      if (result.error) {
        setError(result.error);
      } else {
        dialogRef.current?.close();
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          dialogRef.current?.showModal();
        }}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-red-50 hover:text-red-600"
      >
        <CircleOff className="h-3 w-3" strokeWidth={2.5} />
        הפסקת חיוב חודשי
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setError(null)}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">הפסקת חיוב חודשי</h2>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-zinc-600">
            להפסיק את החיוב החודשי האוטומטי של &quot;{serviceLabel}&quot;? התשלומים
            שכבר נרשמו יישארו כמו שהם — רק חיובים עתידיים ייפסקו. אפשר להפעיל
            מחדש בכל שלב.
          </p>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-4">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-60"
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isPending}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
          >
            {isPending ? "מפסיקה…" : "הפסקת חיוב"}
          </button>
        </div>
      </dialog>
    </>
  );
}
