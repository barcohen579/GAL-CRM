import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import type { FollowUpWithRelations } from "@/lib/crm/types";
import { formatDateTime, formatRelative } from "@/lib/crm/format";

export function FollowUpRow({
  task,
  tone,
}: {
  task: FollowUpWithRelations;
  tone: "overdue" | "today" | "upcoming" | "done";
}) {
  const name =
    task.lead?.contact?.full_name ?? task.customer?.contact?.full_name ?? "לא ידוע";
  const href = task.lead ? "/leads" : "/customers";

  return (
    <div
      className={`flex items-start justify-between gap-4 rounded-xl border px-4 py-3 ${
        tone === "overdue"
          ? "border-red-200 bg-red-50/60"
          : tone === "today"
            ? "border-amber-200 bg-amber-50/50"
            : tone === "done"
              ? "border-zinc-100 bg-zinc-50/60 opacity-70"
              : "border-zinc-200 bg-white"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {tone === "done" && (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          )}
          <p
            className={`truncate text-sm font-medium ${
              tone === "done" ? "text-zinc-500 line-through" : "text-zinc-900"
            }`}
          >
            {task.title}
          </p>
        </div>
        <Link
          href={href}
          className="mt-0.5 block truncate text-xs text-zinc-500 hover:text-rose-600 hover:underline"
        >
          {name}
        </Link>
        {task.notes && (
          <p className="mt-1 truncate text-xs text-zinc-400">{task.notes}</p>
        )}
      </div>

      <div className="shrink-0 text-end">
        <p
          className={`text-xs font-semibold ${
            tone === "overdue"
              ? "text-red-600"
              : tone === "today"
                ? "text-amber-700"
                : "text-zinc-500"
          }`}
        >
          {tone === "done" ? formatDateTime(task.due_at) : formatRelative(task.due_at)}
        </p>
      </div>
    </div>
  );
}
