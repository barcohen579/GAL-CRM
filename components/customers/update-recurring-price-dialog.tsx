"use client";

import { useActionState, useEffect, useRef } from "react";
import { Pencil, X } from "lucide-react";
import {
  updateRecurringPrice,
  type UpdatePriceState,
} from "@/app/(app)/customers/actions";

const initialState: UpdatePriceState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
const labelClass = "text-xs font-medium text-zinc-700";

// "עדכון מחיר חודשי" — changes the monthly amount used starting the
// NEXT un-generated cycle only. Every payment already recorded keeps
// its own original, permanently-frozen amount (see
// updateRecurringPrice's own comment) — this dialog deliberately has
// no date field: there's nothing to pick, it always means "from the
// next cycle on".
export function UpdateRecurringPriceDialog({
  purchaseId,
  customerId,
  currentAmountNis,
}: {
  purchaseId: string;
  customerId: string;
  currentAmountNis: number;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    updateRecurringPrice,
    initialState
  );

  useEffect(() => {
    if (state.success) {
      dialogRef.current?.close();
    }
  }, [state.success]);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50"
      >
        <Pencil className="h-3 w-3" strokeWidth={2.5} />
        עדכון מחיר חודשי
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => formRef.current?.reset()}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">עדכון מחיר חודשי</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              המחיר החדש יחול החל מהחיוב הבא בלבד.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="סגירה"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form ref={formRef} action={formAction} className="px-5 py-4">
          <input type="hidden" name="purchase_id" value={purchaseId} />
          <input type="hidden" name="customer_id" value={customerId} />

          <div className="space-y-1">
            <label htmlFor="up_monthly_amount" className={labelClass}>
              סכום חודשי חדש (₪) *
            </label>
            <input
              id="up_monthly_amount"
              name="monthly_amount"
              type="number"
              min="0"
              step="1"
              required
              dir="ltr"
              defaultValue={currentAmountNis}
              className={`${inputClass} text-left`}
            />
          </div>

          {state.error && (
            <p
              role="alert"
              className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {state.error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2 border-t border-zinc-100 pt-4">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
            >
              ביטול
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-60"
            >
              {isPending ? "מעדכנת…" : "עדכון מחיר"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
