"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, Pencil, X, Repeat } from "lucide-react";
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

// "חד־פעמית" / "חודשית קבועה" — deliberately its own small vocabulary,
// not RECURRENCE_LABELS (that one's phrasing is for a customer
// Purchase's payment recurrence, a different concept/screen).
const EXPENSE_KIND_LABELS = {
  ONE_TIME: "חד־פעמית",
  RECURRING_MONTHLY: "חודשית קבועה",
} as const;

// "הוספת הוצאה" / "עריכת הוצאה" — one dialog for both: passing
// `expense` switches it into edit mode (calls updateExpense,
// pre-filled, "שמירת שינויים") instead of add mode (calls addExpense,
// blank, "הוספת הוצאה"). The one-time/recurring toggle only appears in
// ADD mode — editing an existing row always corrects just that one
// row's own fields (see expense-list.tsx/recurring-expenses-manager.tsx
// for the separate "שינוי סכום חודשי"/"הפסקת הוצאה חודשית" actions that
// manage a recurring SERIES itself). Never touches Meta spend — that
// stays fully automatic via meta_campaign_daily_metrics (see
// app/(app)/dashboard/actions.ts).
export function ExpenseDialog({ expense }: { expense?: ExistingExpense }) {
  const isEdit = Boolean(expense);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const action = isEdit ? updateExpense : addExpense;
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [kind, setKind] = useState<"ONE_TIME" | "RECURRING_MONTHLY">("ONE_TIME");

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
        onClose={() => {
          formRef.current?.reset();
          setKind("ONE_TIME");
        }}
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

            {!isEdit && (
              <div className="space-y-1">
                <label htmlFor="exp_kind" className={labelClass}>
                  סוג
                </label>
                <select
                  id="exp_kind"
                  name="kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "ONE_TIME" | "RECURRING_MONTHLY")}
                  className={inputClass}
                >
                  <option value="ONE_TIME">{EXPENSE_KIND_LABELS.ONE_TIME}</option>
                  <option value="RECURRING_MONTHLY">{EXPENSE_KIND_LABELS.RECURRING_MONTHLY}</option>
                </select>
                {kind === "RECURRING_MONTHLY" && (
                  <p className="flex items-start gap-1 text-[11px] text-zinc-400">
                    <Repeat className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                    הוצאה זו תתווסף אוטומטית בכל חודש עד שתופסק.
                  </p>
                )}
              </div>
            )}

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
