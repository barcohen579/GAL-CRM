"use client";

import { forwardRef, useRef, useState } from "react";
import { useActionState } from "react";
import {
  convertLeadToWon,
  type ConvertToWonState,
} from "@/app/(app)/leads/actions";
import { SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceType } from "@/lib/crm/constants";

const initialState: ConvertToWonState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
const labelClass = "text-xs font-medium text-zinc-700";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export const WonConversionDialog = forwardRef<
  HTMLDialogElement,
  {
    leadId: string;
    contactName: string;
    interestedServices?: ServiceType[];
  }
>(function WonConversionDialog(
  { leadId, contactName, interestedServices = [] },
  ref
) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    convertLeadToWon,
    initialState
  );
  const [serviceType, setServiceType] = useState("");

  // No "on success" handling here (unlike the old version, which had an
  // onDone prop the parent used to close this dialog after a
  // client-visible success state): a successful submission now
  // redirects server-side, to the newly-converted customer's page —
  // see the action — navigating away entirely before the client ever
  // sees a normal return. onClose below only ever fires for an
  // unsuccessful dismissal (Cancel / backdrop / Esc), where resetting
  // local state is all that's needed.

  return (
    <dialog
      ref={ref}
      onClose={() => {
        formRef.current?.reset();
        setServiceType("");
      }}
      className="w-full max-w-lg rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
    >
      <div className="border-b border-zinc-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-900">
          סגירת ליד — {contactName}
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          פרטי העסקה ייצרו לקוחה (אם עוד אין) ורכישה חדשה.
        </p>
        {interestedServices.length > 0 && (
          <p className="mt-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">
            היא התעניינה ב: {interestedServices.map((s) => SERVICE_TYPE_LABELS[s]).join(", ")}
            {" — "}
            בחרי למטה מה בפועל נרכש (לא בהכרח הכול).
          </p>
        )}
      </div>

      <form ref={formRef} action={formAction} className="px-5 py-4">
        <input type="hidden" name="lead_id" value={leadId} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2 space-y-1">
            <label htmlFor="service_type" className={labelClass}>
              השירות שנרכש *
            </label>
            <select
              id="service_type"
              name="service_type"
              required
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              className={inputClass}
            >
              <option value="">בחרי שירות</option>
              {SERVICE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_TYPE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {serviceType === "OTHER" && (
            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="custom_service_name" className={labelClass}>
                שם השירות *
              </label>
              <input
                id="custom_service_name"
                name="custom_service_name"
                required
                className={inputClass}
                placeholder="פרטי איזה שירות"
              />
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="agreed_price" className={labelClass}>
              מחיר מוסכם (₪) *
            </label>
            <input
              id="agreed_price"
              name="agreed_price"
              type="number"
              min="0"
              step="1"
              required
              dir="ltr"
              className={`${inputClass} text-left`}
              placeholder="350"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="recurrence" className={labelClass}>
              סוג תשלום
            </label>
            <select
              id="recurrence"
              name="recurrence"
              defaultValue="ONE_TIME"
              className={inputClass}
            >
              <option value="ONE_TIME">חד פעמי</option>
              <option value="RECURRING_MONTHLY">חודשי (מתחדש)</option>
            </select>
          </div>

          <div className="sm:col-span-2 space-y-1">
            <label htmlFor="start_date" className={labelClass}>
              תאריך התחלה *
            </label>
            <input
              id="start_date"
              name="start_date"
              type="date"
              required
              dir="ltr"
              defaultValue={todayIso()}
              className={`${inputClass} text-left`}
            />
          </div>

          <div className="sm:col-span-2 space-y-1">
            <label htmlFor="won_notes" className={labelClass}>
              הערות
            </label>
            <textarea
              id="won_notes"
              name="notes"
              rows={2}
              className={inputClass}
              placeholder="פרטים נוספים על העסקה…"
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
            onClick={() => (ref as React.RefObject<HTMLDialogElement>)?.current?.close()}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            ביטול
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
          >
            {isPending ? "סוגרת…" : "סגירת הליד"}
          </button>
        </div>
      </form>
    </dialog>
  );
});
