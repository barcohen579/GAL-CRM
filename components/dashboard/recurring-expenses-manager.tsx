"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Repeat, Pencil, CircleOff, X } from "lucide-react";
import {
  updateRecurringExpenseAmount,
  stopRecurringExpense,
  type UpdateRecurringExpenseAmountState,
} from "@/app/(app)/dashboard/actions";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/crm/format";
import { BUSINESS_EXPENSE_CATEGORY_LABELS } from "@/lib/crm/constants";
import type { BusinessExpenseCategory } from "@/lib/crm/constants";

export type RecurringExpenseRow = {
  id: string;
  description: string | null;
  category: BusinessExpenseCategory;
  amount_minor: number;
  status: "ACTIVE" | "STOPPED";
};

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100 text-left";
const labelClass = "text-xs font-medium text-zinc-700";
const initialState: UpdateRecurringExpenseAmountState = { error: null };

// "הוצאות קבועות" — separate from the month's ExpenseList (which shows
// individual LEDGER rows, one per month, badge-only): this manages the
// underlying recurring SERIES itself — current amount and active/
// stopped state — exactly the same conceptual split
// UpdateRecurringPriceDialog/StopRecurringButton already provide for a
// customer's recurring Purchase, applied here to
// business_recurring_expenses instead. Not month-scoped (a recurring
// definition isn't a dated event) — always shows every recurring
// expense that currently exists, stopped ones included, so Gal can see
// what she once had running.
export function RecurringExpensesManager({
  recurringExpenses,
}: {
  recurringExpenses: RecurringExpenseRow[];
}) {
  return (
    <Card>
      <CardHeader
        title="הוצאות קבועות"
        description="הוצאות שחוזרות אוטומטית כל חודש עד שמפסיקים אותן."
      />
      {recurringExpenses.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Repeat}
            title="אין עדיין הוצאות חודשיות קבועות"
            description='הוסיפי הוצאה מסוג "חודשית קבועה" דרך "הוספת הוצאה" — היא תופיע כאן.'
          />
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {recurringExpenses.map((re) => (
            <RecurringExpenseListItem key={re.id} recurringExpense={re} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecurringExpenseListItem({
  recurringExpense,
}: {
  recurringExpense: RecurringExpenseRow;
}) {
  const isActive = recurringExpense.status === "ACTIVE";
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium text-zinc-900">
            {BUSINESS_EXPENSE_CATEGORY_LABELS[recurringExpense.category] ??
              recurringExpense.category}
          </p>
          <Badge tone={isActive ? "info" : "neutral"}>
            {isActive ? "פעילה" : "הופסקה"}
          </Badge>
        </div>
        {recurringExpense.description && (
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {recurringExpense.description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm font-semibold text-zinc-900">
          {formatMoney(recurringExpense.amount_minor)}
          <span className="text-xs font-normal text-zinc-400"> / חודש</span>
        </span>
        {isActive && (
          <div className="flex items-center gap-1.5">
            <UpdateRecurringExpenseAmountDialog
              recurringExpenseId={recurringExpense.id}
              currentAmountNis={recurringExpense.amount_minor / 100}
            />
            <StopRecurringExpenseButton
              recurringExpenseId={recurringExpense.id}
              label={
                recurringExpense.description ||
                BUSINESS_EXPENSE_CATEGORY_LABELS[recurringExpense.category]
              }
            />
          </div>
        )}
      </div>
    </li>
  );
}

// "שינוי סכום חודשי" — mirrors UpdateRecurringPriceDialog exactly: the
// new amount applies starting the NEXT un-generated occurrence only.
// Every already-generated business_expenses row keeps its own frozen
// amount_minor — see updateRecurringExpenseAmount's own comment.
function UpdateRecurringExpenseAmountDialog({
  recurringExpenseId,
  currentAmountNis,
}: {
  recurringExpenseId: string;
  currentAmountNis: number;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    updateRecurringExpenseAmount,
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
        aria-label="שינוי סכום חודשי"
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-300 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
      >
        <Pencil className="h-3 w-3" strokeWidth={2.5} />
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => formRef.current?.reset()}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">שינוי סכום חודשי</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              הסכום החדש יחול החל מהחודש הבא בלבד — חודשים קודמים לא ישתנו.
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
          <input type="hidden" name="recurring_expense_id" value={recurringExpenseId} />

          <div className="space-y-1">
            <label htmlFor="re_monthly_amount" className={labelClass}>
              סכום חודשי חדש (₪) *
            </label>
            <input
              id="re_monthly_amount"
              name="monthly_amount"
              type="number"
              min="0"
              step="1"
              required
              dir="ltr"
              defaultValue={currentAmountNis}
              className={inputClass}
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
              {isPending ? "מעדכנת…" : "עדכון סכום"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

// "הפסקת הוצאה חודשית" — mirrors StopRecurringButton exactly: stops
// all FUTURE automatic occurrences. Never touches any already-generated
// business_expenses row.
function StopRecurringExpenseButton({
  recurringExpenseId,
  label,
}: {
  recurringExpenseId: string;
  label: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await stopRecurringExpense(recurringExpenseId);
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
        aria-label="הפסקת הוצאה חודשית"
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-300 text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600"
      >
        <CircleOff className="h-3 w-3" strokeWidth={2.5} />
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setError(null)}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">הפסקת הוצאה חודשית</h2>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-zinc-600">
            להפסיק את ההוצאה החודשית הקבועה &quot;{label}&quot;? הוצאות שכבר
            נרשמו יישארו כמו שהן — רק חודשים עתידיים ייפסקו.
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
            {isPending ? "מפסיקה…" : "הפסקת הוצאה"}
          </button>
        </div>
      </dialog>
    </>
  );
}
