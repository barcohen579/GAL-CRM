import { Wallet } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ExpenseDialog } from "./expense-dialog";
import { formatDate, formatMoney } from "@/lib/crm/format";
import { BUSINESS_EXPENSE_CATEGORY_LABELS } from "@/lib/crm/constants";
import type { BusinessExpenseCategory } from "@/lib/crm/constants";

export type BusinessExpenseRow = {
  id: string;
  expense_date: string;
  amount_minor: number;
  category: BusinessExpenseCategory;
  description: string | null;
};

// Compact list of the SELECTED month's manually-entered expenses —
// never Meta spend (that's shown separately, already automatic). Each
// row can be corrected via ExpenseDialog in edit mode; there is no
// delete action anywhere in the UI, matching business_expenses having
// no DELETE RLS policy at all — expense history can only be corrected,
// never destroyed.
export function ExpenseList({
  expenses,
  totalMinor,
}: {
  expenses: BusinessExpenseRow[];
  totalMinor: number;
}) {
  return (
    <Card>
      <CardHeader
        title="הוצאות עסק"
        description={
          expenses.length > 0 ? `סה״כ החודש: ${formatMoney(totalMinor)}` : undefined
        }
        action={<ExpenseDialog />}
      />
      {expenses.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Wallet}
            title="עדיין לא נרשמו הוצאות החודש"
            description='הוצאות שיירשמו יופיעו כאן — לחצי על "הוספת הוצאה".'
          />
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {expenses.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-900">
                  {BUSINESS_EXPENSE_CATEGORY_LABELS[e.category] ?? e.category}
                </p>
                <p className="mt-0.5 truncate text-xs text-zinc-500">
                  {formatDate(e.expense_date)}
                  {e.description ? ` · ${e.description}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-sm font-semibold text-zinc-900">
                  {formatMoney(e.amount_minor)}
                </span>
                <ExpenseDialog expense={e} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
