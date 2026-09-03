"use client";

import { useRef, useState, useTransition } from "react";
import { CircleX } from "lucide-react";
import { markPaymentUnpaid } from "@/app/(app)/payments/actions";

// "לא שילמה החודש" — corrects a PAID payment (typically auto-
// generated) to FAILED after the fact, when the assumed monthly
// payment turns out not to have actually happened. Never deletes or
// rewrites the amount/date/method — only status/notes change (see
// markPaymentUnpaid's own comment on why this is safe under the
// payments append-only trigger). Confirmation required, matching this
// app's established pattern for a consequential financial correction.
export function MarkPaymentUnpaidButton({
  paymentId,
  customerId,
}: {
  paymentId: string;
  customerId: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await markPaymentUnpaid(paymentId, customerId);
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
        className="flex items-center gap-1 text-[11px] font-medium text-zinc-400 transition-colors hover:text-red-600"
      >
        <CircleX className="h-3 w-3" strokeWidth={2.5} />
        לא שילמה החודש
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setError(null)}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">סימון כלא שולם</h2>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-zinc-600">
            התשלום הזה יסומן כלא שולם ולא ייחשב בהכנסות. הרישום המקורי יישמר
            לצורך מעקב — הוא לא יימחק. מנוי החודשי ימשיך כרגיל בחודש הבא.
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
            {isPending ? "מסמנת…" : "לא שולם"}
          </button>
        </div>
      </dialog>
    </>
  );
}
