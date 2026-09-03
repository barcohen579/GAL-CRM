"use client";

import { useRef, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { deleteLead } from "@/app/(app)/leads/actions";

// Deliberately destructive, permanent action — see
// delete_lead_safely() (supabase/migrations/20260903101406_...sql) for
// the safety guarantees this button relies on: it can never destroy a
// Customer/purchase/payment record, and either fully succeeds or
// leaves nothing partially deleted. A plain browser confirm() is never
// used — this dialog matches the rest of the app's existing
// confirmation pattern (see components/leads/lost-reason-dialog.tsx).
export function DeleteLeadButton({ leadId }: { leadId: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteLead(leadId);
      // On success the action itself redirects — this line is only
      // ever reached when deletion was blocked or failed.
      if (result?.error) {
        setError(result.error);
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
        className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
      >
        <Trash2 className="h-4 w-4" strokeWidth={2} />
        מחיקת ליד
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setError(null)}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">מחיקת ליד</h2>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-zinc-600">
            האם למחוק את הליד לצמיתות? פעולה זו אינה ניתנת לביטול.
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
            {isPending ? "מוחקת…" : "מחק ליד"}
          </button>
        </div>
      </dialog>
    </>
  );
}
