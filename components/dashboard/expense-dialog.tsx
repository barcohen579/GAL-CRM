"use client";

import { useActionState, useEffect, useRef } from "react";
import { Plus, Pencil, X } from "lucide-react";
import {
  addExpense,
  updateExpense,
  type ExpenseState,
} from "@/app/(app)/dashboard/actions";
import {
  BUSINESS_EXPENSE_CATEGORIES,
  BUSINESS_EXPENSE_CATEGORY_LABELS,
} from "@/lib/crm/constants";

const initialState: ExpenseState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
const ltrInputClass = `${inputClass} text-left`;
const labelClass = "text-xs font-medium text-zinc-700";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

type ExistingExpense = {
  id: string;
  expense_date: string;
  amount_minor: number;
  category: string;
  description: string | null;
};

// "הוספת הוצאה" / "עריכת הוצאה" — one dialog for both: passing
// `expense` switches it into edit mode (calls updateExpense,
// pre-filled, "שמירת שינויים") instead of add mode (calls addExpense,
// blank, "הוספת הוצאה"). Never touches Meta spend — that stays fully
// automatic via meta_campaign_daily_metrics (see
// app/(app)/dashboard/actions.ts).
export function ExpenseDialog({ expense }: { expense?: ExistingExpense }) {
  const isEdit = Boolean(expense);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const action = isEdit ? updateExpense : addExpense;
  const [state, formAction, isPending] = useActionState(action, initialState);

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
        className={
          isEdit
            ? "flex items-center gap-1 text-[11px] font-medium text-zinc-400 transition-colors hover:text-rose-600"
            : "flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-rose-200 transition-colors hover:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
        }
      >
        {isEdit ? (
          <>
            <Pencil className="h-3 w-3" strokeWidth={2.5} />
            עריכה
          </>
        ) : (
          <>
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            הוספת הוצאה
          </>
        )}
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => formRef.current?.reset()}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            {isEdit ? "עריכת הוצאה" : "הוספת הוצאה"}
          </h2>
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
          {isEdit && <input type="hidden" name="expense_id" value={expense!.id} />}

          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="exp_amount" className={labelClass}>
                סכום (₪) *
              </label>
              <input
                id="exp_amount"
                name="amount"
                type="number"
                min="0"
                step="1"
                required
                dir="ltr"
                defaultValue={isEdit ? expense!.amount_minor / 100 : undefined}
                className={ltrInputClass}
                placeholder="800"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="exp_date" className={labelClass}>
                תאריך *
              </label>
              <input
                id="exp_date"
                name="expense_date"
                type="date"
                required
                dir="ltr"
                defaultValue={isEdit ? expense!.expense_date : todayIso()}
                className={ltrInputClass}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="exp_category" className={labelClass}>
                קטגוריה *
              </label>
              <select
                id="exp_category"
                name="category"
                required
                defaultValue={isEdit ? expense!.category : ""}
                className={inputClass}
              >
                <option value="" disabled>
                  בחרי קטגוריה
                </option>
                {BUSINESS_EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {BUSINESS_EXPENSE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="exp_description" className={labelClass}>
                תיאור
              </label>
              <textarea
                id="exp_description"
                name="description"
                rows={2}
                defaultValue={isEdit ? (expense!.description ?? "") : undefined}
                className={inputClass}
                placeholder='לדוגמה: "CapCut + software"'
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
              {isPending ? "שומרת…" : isEdit ? "שמירת שינויים" : "הוספת הוצאה"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
