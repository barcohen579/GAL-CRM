import Link from "next/link";
import { ChevronRight, ChevronLeft, CalendarDays } from "lucide-react";
import type { SelectedMonth } from "@/lib/crm/date-range";

// "חודש להצגה" — prev/next calendar-month navigation for the Monthly
// Business Report. The URL (?month=YYYY-MM) is the single source of
// truth for which month is selected — reload-safe and linkable, per
// the task's own requirement. next is a plain <a>/Link, disabled
// (rendered, not hidden) when already at the current month: there is
// nothing meaningful to show for a future month (see
// resolveSelectedMonth's own reasoning), so navigating further is
// capped rather than merely inconvenient to reach.
export function MonthSelector({ selectedMonth }: { selectedMonth: SelectedMonth }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 bg-white p-1 shadow-sm">
      <Link
        href={`/dashboard?month=${selectedMonth.previousMonthKey}`}
        aria-label="חודש קודם"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
      >
        <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
      </Link>

      <div className="flex items-center gap-2 px-2">
        <CalendarDays className="h-4 w-4 text-rose-500" strokeWidth={2} />
        <span className="text-sm font-semibold text-zinc-900">{selectedMonth.label}</span>
        {selectedMonth.isCurrentMonth && (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-600">
            חודש נוכחי · חלקי
          </span>
        )}
      </div>

      {selectedMonth.nextMonthKey ? (
        <Link
          href={`/dashboard?month=${selectedMonth.nextMonthKey}`}
          aria-label="חודש הבא"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
        </Link>
      ) : (
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-200"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}
