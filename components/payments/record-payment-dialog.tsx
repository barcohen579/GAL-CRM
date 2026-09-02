"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  recordPayment,
  type RecordPaymentState,
} from "@/app/(app)/payments/actions";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  SERVICE_TYPE_LABELS,
} from "@/lib/crm/constants";
import type { PurchaseSummary } from "@/lib/crm/types";

const initialState: RecordPaymentState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
const labelClass = "text-xs font-medium text-zinc-700";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function RecordPaymentDialog({
  customerId,
  purchases,
}: {
  customerId: string;
  purchases: PurchaseSummary[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    recordPayment,
    initialState
  );
  const [purchaseId, setPurchaseId] = useState(purchases[0]?.id ?? "");

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      dialogRef.current?.close();
    }
  }, [state.success]);

  if (purchases.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        רישום תשלום
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => formRef.current?.reset()}
        className="w-full max-w-md rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">רישום תשלום</h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="סגירה"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form ref={formRef} action={formAction} className="px-5 py-4">
          <input type="hidden" name="customer_id" value={customerId} />

          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="purchase_id" className={labelClass}>
                רכישה *
              </label>
              <select
                id="purchase_id"
                name="purchase_id"
                required
                value={purchaseId}
                onChange={(e) => setPurchaseId(e.target.value)}
                className={inputClass}
              >
                {purchases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.custom_service_name ?? SERVICE_TYPE_LABELS[p.service_type]}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="amount" className={labelClass}>
                  סכום (₪) *
                </label>
                <input
                  id="amount"
                  name="amount"
                  type="number"
                  min="0"
                  step="1"
                  required
                  dir="ltr"
                  className={`${inputClass} text-left`}
                  placeholder="350"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="paid_at" className={labelClass}>
                  תאריך תשלום *
                </label>
                <input
                  id="paid_at"
                  name="paid_at"
                  type="date"
                  required
                  dir="ltr"
                  defaultValue={todayIso()}
                  className={`${inputClass} text-left`}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="method" className={labelClass}>
                  אמצעי תשלום *
                </label>
                <select id="method" name="method" required defaultValue="" className={inputClass}>
                  <option value="" disabled>
                    בחרי אמצעי
                  </option>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="status" className={labelClass}>
                  סטטוס
                </label>
                <select id="status" name="status" defaultValue="PAID" className={inputClass}>
                  <option value="PAID">שולם</option>
                  <option value="REFUNDED">זוכה</option>
                  <option value="FAILED">נכשל</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="payment_notes" className={labelClass}>
                הערות
              </label>
              <textarea
                id="payment_notes"
                name="notes"
                rows={2}
                className={inputClass}
                placeholder="פרטים נוספים…"
              />
            </div>
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
              {isPending ? "שומרת…" : "שמירת תשלום"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
