"use client";

import { useActionState, useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import { createLead, type CreateLeadState } from "@/app/(app)/leads/actions";
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  TOUCHPOINT_CHANNELS,
  TOUCHPOINT_CHANNEL_LABELS,
} from "@/lib/crm/constants";

const initialState: CreateLeadState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
// Phone / email / Instagram values are inherently Latin-script and read
// far better left-to-right even inside an otherwise RTL form — mixing
// direction only on these specific fields, not the whole form.
const ltrInputClass = `${inputClass} text-left`;
const labelClass = "text-xs font-medium text-zinc-700";

export function AddLeadDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    createLead,
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
        className="flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-rose-200 transition-colors hover:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
      >
        <Plus className="h-4 w-4" strokeWidth={2.5} />
        הוספת ליד
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => formRef.current?.reset()}
        className="w-full max-w-lg rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40 open:animate-in"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">הוספת ליד</h2>
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="full_name" className={labelClass}>
                שם מלא *
              </label>
              <input
                id="full_name"
                name="full_name"
                required
                className={inputClass}
                placeholder="שירה כהן"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="phone" className={labelClass}>
                טלפון
              </label>
              <input
                id="phone"
                name="phone"
                type="tel"
                dir="ltr"
                className={ltrInputClass}
                placeholder="05X-XXXXXXX"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="email" className={labelClass}>
                אימייל
              </label>
              <input
                id="email"
                name="email"
                type="email"
                dir="ltr"
                className={ltrInputClass}
                placeholder="shira@example.com"
              />
            </div>

            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="instagram_username" className={labelClass}>
                שם משתמש באינסטגרם
              </label>
              <input
                id="instagram_username"
                name="instagram_username"
                dir="ltr"
                className={ltrInputClass}
                placeholder="shira.c (לא חובה)"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="interested_service" className={labelClass}>
                שירות שמעניין אותה
              </label>
              <select
                id="interested_service"
                name="interested_service"
                defaultValue=""
                className={inputClass}
              >
                <option value="">עדיין לא ברור</option>
                {SERVICE_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_TYPE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="channel" className={labelClass}>
                מקור הליד
              </label>
              <select
                id="channel"
                name="channel"
                defaultValue=""
                className={inputClass}
              >
                <option value="">לא ידוע / לא בטוחה</option>
                {TOUCHPOINT_CHANNELS.filter((c) => c !== "UNKNOWN").map((c) => (
                  <option key={c} value={c}>
                    {TOUCHPOINT_CHANNEL_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="follow_up_at" className={labelClass}>
                תאריך ושעת מעקב (לא חובה)
              </label>
              <input
                id="follow_up_at"
                name="follow_up_at"
                type="datetime-local"
                dir="ltr"
                className={ltrInputClass}
              />
            </div>

            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="notes" className={labelClass}>
                הערות
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={3}
                className={inputClass}
                placeholder="כל דבר ששווה לזכור לגבי הליד הזה…"
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
              {isPending ? "שומרת…" : "הוספת ליד"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
