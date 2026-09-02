"use client";

import { useRef, useState, useTransition } from "react";
import { Check, X as XIcon } from "lucide-react";
import { completeFollowUp, cancelFollowUp } from "@/app/(app)/follow-ups/actions";

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors focus:border-rose-400 focus:ring-2 focus:ring-rose-100";

// Inline complete/cancel controls for one PENDING follow-up task. Used
// both on the Follow-ups page and inside the lead-details follow-up
// list, so it takes the parent (lead or customer) explicitly rather
// than assuming context.
export function FollowUpTaskActions({
  taskId,
  leadId,
  customerId,
}: {
  taskId: string;
  leadId?: string | null;
  customerId?: string | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState("");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleComplete() {
    startTransition(async () => {
      const result = await completeFollowUp(taskId, note || null, leadId, customerId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setNote("");
      dialogRef.current?.close();
    });
  }

  function handleCancel() {
    startTransition(async () => {
      const result = await cancelFollowUp(taskId, leadId, customerId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setConfirmingCancel(false);
    });
  }

  if (confirmingCancel) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-zinc-500">לבטל את המעקב?</span>
        <button
          type="button"
          onClick={handleCancel}
          disabled={isPending}
          className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-60"
        >
          כן, לבטל
        </button>
        <button
          type="button"
          onClick={() => setConfirmingCancel(false)}
          className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100"
        >
          חזרה
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        disabled={isPending}
        title="סימון כהושלם"
        className="flex h-7 w-7 items-center justify-center rounded-md text-emerald-600 hover:bg-emerald-50 disabled:opacity-60"
      >
        <Check className="h-4 w-4" strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={() => setConfirmingCancel(true)}
        disabled={isPending}
        title="ביטול מעקב"
        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-red-600 disabled:opacity-60"
      >
        <XIcon className="h-4 w-4" strokeWidth={2.5} />
      </button>

      {error && (
        <span className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {error}
        </span>
      )}

      <dialog
        ref={dialogRef}
        onClose={() => setNote("")}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            סימון מעקב כהושלם
          </h2>
        </div>
        <div className="px-5 py-4">
          <label htmlFor="complete_note" className="text-xs font-medium text-zinc-700">
            הערת סיום (לא חובה)
          </label>
          <textarea
            id="complete_note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${inputClass} mt-1.5`}
            placeholder="מה קרה בשיחה / מה סוכם…"
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-4">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={handleComplete}
            disabled={isPending}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
          >
            {isPending ? "שומרת…" : "סימון כהושלם"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
