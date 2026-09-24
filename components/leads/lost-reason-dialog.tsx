"use client";

import { forwardRef, useState, useTransition } from "react";
import { changeLeadStage } from "@/app/(app)/leads/actions";
import {
  LEAD_LOST_REASONS,
  LEAD_LOST_REASON_LABELS,
} from "@/lib/crm/constants";

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors focus:border-rose-400 focus:ring-2 focus:ring-rose-100";

// Marking a lead LOST ("לא נסגרה") requires a reason. The explanation is
// optional, except for "סיבה אחרת" where it is required. Both are stored
// on the lead and on its stage history (see change_lead_stage).
export const LostReasonDialog = forwardRef<
  HTMLDialogElement,
  { leadId: string; onDone: () => void }
>(function LostReasonDialog({ leadId, onDone }, ref) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const noteRequired = reason === "OTHER";
  const canSubmit = reason !== "" && (!noteRequired || note.trim().length > 0);

  function handleConfirm() {
    if (!reason) {
      setError("יש לבחור סיבה.");
      return;
    }
    if (noteRequired && !note.trim()) {
      setError('כשבוחרים "סיבה אחרת" יש לכתוב הסבר.');
      return;
    }
    startTransition(async () => {
      const result = await changeLeadStage(leadId, "LOST", reason, note || null);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setReason("");
      setNote("");
      onDone();
    });
  }

  return (
    <dialog
      ref={ref}
      onClose={() => {
        setReason("");
        setNote("");
        setError(null);
      }}
      className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
    >
      <div className="border-b border-zinc-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-900">
          סימון הליד כ&quot;לא נסגרה&quot;
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          בחרי את הסיבה העיקרית — זה עוזר לזהות דפוסים בהמשך.
        </p>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div>
          <label htmlFor="lost_reason" className="text-xs font-medium text-zinc-700">
            סיבה *
          </label>
          <select
            id="lost_reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={`${inputClass} mt-1.5`}
          >
            <option value="" disabled>
              בחרי סיבה…
            </option>
            {LEAD_LOST_REASONS.map((r) => (
              <option key={r} value={r}>
                {LEAD_LOST_REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="lost_reason_note" className="text-xs font-medium text-zinc-700">
            {noteRequired ? "הסבר *" : "הסבר נוסף (לא חובה)"}
          </label>
          <textarea
            id="lost_reason_note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${inputClass} mt-1.5`}
            placeholder={noteRequired ? "מה הסיבה?" : "פרטים שכדאי לזכור…"}
          />
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-4">
        <button
          type="button"
          onClick={() => (ref as React.RefObject<HTMLDialogElement>)?.current?.close()}
          className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
        >
          ביטול
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isPending || !canSubmit}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
        >
          {isPending ? "מעדכנת…" : "אישור — לא נסגרה"}
        </button>
      </div>
    </dialog>
  );
});
