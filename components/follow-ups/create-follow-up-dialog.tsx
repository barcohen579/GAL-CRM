"use client";

import { useActionState, useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import {
  createFollowUp,
  type CreateFollowUpState,
} from "@/app/(app)/follow-ups/actions";

const initialState: CreateFollowUpState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
const labelClass = "text-xs font-medium text-zinc-700";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function CreateFollowUpDialog({
  leadId,
  customerId,
}: {
  leadId?: string;
  customerId?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    createFollowUp,
    initialState
  );

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      dialogRef.current?.close();
    }
  }, [state.success]);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        מעקב חדש
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => formRef.current?.reset()}
        className="w-full max-w-md rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">מעקב חדש</h2>
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
          {leadId && <input type="hidden" name="lead_id" value={leadId} />}
          {customerId && (
            <input type="hidden" name="customer_id" value={customerId} />
          )}

          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="title" className={labelClass}>
                מה צריך לעשות *
              </label>
              <input
                id="title"
                name="title"
                required
                className={inputClass}
                placeholder="לחזור אליה בטלפון"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="date" className={labelClass}>
                  תאריך *
                </label>
                <input
                  id="date"
                  name="date"
                  type="date"
                  required
                  dir="ltr"
                  defaultValue={todayIso()}
                  className={`${inputClass} text-left`}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="time" className={labelClass}>
                  שעה *
                </label>
                <input
                  id="time"
                  name="time"
                  type="time"
                  required
                  dir="ltr"
                  className={`${inputClass} text-left`}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="fu_notes" className={labelClass}>
                הערות
              </label>
              <textarea
                id="fu_notes"
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
              {isPending ? "שומרת…" : "שמירת מעקב"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
