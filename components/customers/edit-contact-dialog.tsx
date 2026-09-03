"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Pencil, X, Check } from "lucide-react";
import {
  updateContactDetails,
  type UpdateContactState,
} from "@/app/(app)/customers/actions";

const initialState: UpdateContactState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
// Phone / email / Instagram read far better left-to-right even inside
// an otherwise RTL form — same convention as add-customer-dialog.tsx.
const ltrInputClass = `${inputClass} text-left`;
const labelClass = "text-xs font-medium text-zinc-700";

type ContentProps = {
  contactId: string;
  customerId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  instagramUsername: string | null;
  onRequestClose: () => void;
};

// "עריכת פרטים" — edits the Contact belonging to this Customer in
// place. Never creates a new Contact/Customer, never touches
// purchases/payments/recurring config/leads/touchpoints/referrals —
// see updateContactDetails's own comment
// (app/(app)/customers/actions.ts) for why a referral display never
// needs to change separately: it's read fresh via the same Contact id
// on every page load.
//
// The outer component only owns the <dialog> element and an
// `openKey` counter; the actual form/useActionState lives in the
// inner EditContactDialogContent, remounted fresh (via `key={openKey}`)
// every time the dialog opens. This is deliberate: useActionState's
// state has no reset method of its own, and a successful save renders
// a completely different "success" view in place of the form (see
// below) — without a fresh remount, reopening the dialog after a
// prior successful save would show that stale success screen again
// instead of the form.
export function EditContactDialog(props: Omit<ContentProps, "onRequestClose">) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [openKey, setOpenKey] = useState(0);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpenKey((k) => k + 1);
          dialogRef.current?.showModal();
        }}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
      >
        <Pencil className="h-3.5 w-3.5" strokeWidth={2.5} />
        עריכת פרטים
      </button>

      <dialog
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <EditContactDialogContent
          key={openKey}
          {...props}
          onRequestClose={() => dialogRef.current?.close()}
        />
      </dialog>
    </>
  );
}

function EditContactDialogContent({
  contactId,
  customerId,
  fullName,
  phone,
  email,
  instagramUsername,
  onRequestClose,
}: ContentProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    updateContactDetails,
    initialState
  );

  // A brief in-dialog success flash, then auto-close — this action
  // doesn't redirect (unlike e.g. createCustomerDirectly), so there's
  // no natural "?created=1" banner moment; the updated details are
  // already visible in the card behind the dialog by the time it closes.
  useEffect(() => {
    if (state.success) {
      const timer = setTimeout(onRequestClose, 1100);
      return () => clearTimeout(timer);
    }
  }, [state.success, onRequestClose]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-900">עריכת פרטים</h2>
        <button
          type="button"
          onClick={onRequestClose}
          aria-label="סגירה"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {state.success ? (
        <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <Check className="h-5 w-5" strokeWidth={2.5} />
          </span>
          <p className="text-sm font-medium text-emerald-700">הפרטים נשמרו בהצלחה</p>
        </div>
      ) : (
        <form ref={formRef} action={formAction} className="px-5 py-4">
          <input type="hidden" name="contact_id" value={contactId} />
          <input type="hidden" name="customer_id" value={customerId} />

          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="ec_full_name" className={labelClass}>
                שם מלא *
              </label>
              <input
                id="ec_full_name"
                name="full_name"
                required
                defaultValue={fullName}
                className={inputClass}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="ec_phone" className={labelClass}>
                טלפון
              </label>
              <input
                id="ec_phone"
                name="phone"
                type="tel"
                dir="ltr"
                defaultValue={phone ?? ""}
                className={ltrInputClass}
                placeholder="05X-XXXXXXX"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="ec_email" className={labelClass}>
                אימייל
              </label>
              <input
                id="ec_email"
                name="email"
                type="email"
                dir="ltr"
                defaultValue={email ?? ""}
                className={ltrInputClass}
                placeholder="shira@example.com"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="ec_instagram_username" className={labelClass}>
                אינסטגרם
              </label>
              <input
                id="ec_instagram_username"
                name="instagram_username"
                dir="ltr"
                defaultValue={instagramUsername ?? ""}
                className={ltrInputClass}
                placeholder="shira.c"
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
              onClick={onRequestClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
            >
              ביטול
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-60"
            >
              {isPending ? "שומרת…" : "שמירת שינויים"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
