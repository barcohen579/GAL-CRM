"use client";

import { useActionState, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  createCustomerDirectly,
  type CreateCustomerState,
} from "@/app/(app)/customers/actions";
import {
  CustomerSearchSelect,
  type CustomerSearchOption,
} from "@/components/customers/customer-search-select";
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  TOUCHPOINT_CHANNELS,
  TOUCHPOINT_CHANNEL_LABELS,
} from "@/lib/crm/constants";

const initialState: CreateCustomerState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
// Phone / email / Instagram / money / dates read far better
// left-to-right even inside an otherwise RTL form (see
// components/leads/add-lead-dialog.tsx for the same convention).
const ltrInputClass = `${inputClass} text-left`;
const labelClass = "text-xs font-medium text-zinc-700";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// Direct customer entry — for someone who already IS a customer
// (existing, real customers Gal is backfilling into the CRM), not a
// lead who converted. Deliberately never creates a Lead or a
// Touchpoint — see app/(app)/customers/actions.ts.
export function AddCustomerDialog({
  customers = [],
}: {
  customers?: CustomerSearchOption[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    createCustomerDirectly,
    initialState
  );
  const [serviceType, setServiceType] = useState("");
  const [recordPayment, setRecordPayment] = useState(false);
  const [source, setSource] = useState("");

  // No "on success" effect needed here (unlike e.g. WonConversionDialog):
  // a successful submission redirects server-side (see the action),
  // navigating away entirely — this component just needs to reset its
  // local state whenever the dialog is reopened later, via onClose below.

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-rose-200 transition-colors hover:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
      >
        <Plus className="h-4 w-4" strokeWidth={2.5} />
        הוספת לקוחה
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => {
          formRef.current?.reset();
          setServiceType("");
          setRecordPayment(false);
          setSource("");
        }}
        className="w-full max-w-lg rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">הוספת לקוחה</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              ללקוחה קיימת — לא יוצר ליד.
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

        <form
          ref={formRef}
          action={formAction}
          className="max-h-[75vh] overflow-y-auto px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="cust_full_name" className={labelClass}>
                שם מלא *
              </label>
              <input
                id="cust_full_name"
                name="full_name"
                required
                className={inputClass}
                placeholder="שירה כהן"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="cust_phone" className={labelClass}>
                טלפון
              </label>
              <input
                id="cust_phone"
                name="phone"
                type="tel"
                dir="ltr"
                className={ltrInputClass}
                placeholder="05X-XXXXXXX"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="cust_email" className={labelClass}>
                אימייל
              </label>
              <input
                id="cust_email"
                name="email"
                type="email"
                dir="ltr"
                className={ltrInputClass}
                placeholder="shira@example.com"
              />
            </div>

            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="cust_instagram_username" className={labelClass}>
                אינסטגרם
              </label>
              <input
                id="cust_instagram_username"
                name="instagram_username"
                dir="ltr"
                className={ltrInputClass}
                placeholder="shira.c (לא חובה)"
              />
            </div>

            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="cust_source" className={labelClass}>
                מקור הגעה
              </label>
              <select
                id="cust_source"
                name="source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className={inputClass}
              >
                <option value="">לא ידוע / לא רלוונטי</option>
                {TOUCHPOINT_CHANNELS.filter((c) => c !== "UNKNOWN").map((c) => (
                  <option key={c} value={c}>
                    {TOUCHPOINT_CHANNEL_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>

            {source === "REFERRAL" && (
              <div className="sm:col-span-2 space-y-1">
                <label htmlFor="cust_referrer_customer_id" className={labelClass}>
                  הופנתה על ידי
                </label>
                <CustomerSearchSelect
                  name="referrer_customer_id"
                  customers={customers}
                />
                <p className="text-[11px] text-zinc-400">
                  מומלץ לבחור לקוחה קיימת, אך אפשר גם להשאיר ריק אם לא ידוע.
                </p>
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-zinc-100 pt-4">
            <p className="mb-3 text-xs font-semibold text-zinc-500">השירות שנרכש</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="cust_service_type" className={labelClass}>
                  שירות *
                </label>
                <select
                  id="cust_service_type"
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

              <div className="space-y-1">
                <label htmlFor="cust_agreed_price" className={labelClass}>
                  מחיר מוסכם (₪) *
                </label>
                <input
                  id="cust_agreed_price"
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

              {serviceType === "OTHER" && (
                <div className="sm:col-span-2 space-y-1">
                  <label htmlFor="cust_custom_service_name" className={labelClass}>
                    שם השירות *
                  </label>
                  <input
                    id="cust_custom_service_name"
                    name="custom_service_name"
                    required
                    className={inputClass}
                    placeholder="פרטי איזה שירות"
                  />
                </div>
              )}

              <div className="sm:col-span-2 space-y-1">
                <label htmlFor="cust_purchase_notes" className={labelClass}>
                  הערות על הרכישה
                </label>
                <textarea
                  id="cust_purchase_notes"
                  name="purchase_notes"
                  rows={2}
                  className={inputClass}
                  placeholder="לא חובה…"
                />
              </div>
            </div>
          </div>

          <div className="mt-5 border-t border-zinc-100 pt-4">
            <label className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
              <input
                type="checkbox"
                checked={recordPayment}
                onChange={(e) => setRecordPayment(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-300 text-rose-600 focus:ring-rose-300"
              />
              רישום תשלום ראשון (לא חובה)
            </label>

            {recordPayment && (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor="cust_payment_amount" className={labelClass}>
                    סכום ששולם (₪) *
                  </label>
                  <input
                    id="cust_payment_amount"
                    name="payment_amount"
                    type="number"
                    min="0"
                    step="1"
                    required={recordPayment}
                    dir="ltr"
                    className={`${inputClass} text-left`}
                    placeholder="350"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="cust_payment_paid_at" className={labelClass}>
                    תאריך תשלום *
                  </label>
                  <input
                    id="cust_payment_paid_at"
                    name="payment_paid_at"
                    type="date"
                    required={recordPayment}
                    dir="ltr"
                    defaultValue={todayIso()}
                    className={`${inputClass} text-left`}
                  />
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <label htmlFor="cust_payment_method" className={labelClass}>
                    אמצעי תשלום *
                  </label>
                  <select
                    id="cust_payment_method"
                    name="payment_method"
                    required={recordPayment}
                    defaultValue=""
                    className={inputClass}
                  >
                    <option value="" disabled>
                      בחרי אמצעי
                    </option>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <label htmlFor="cust_payment_notes" className={labelClass}>
                    הערות על התשלום
                  </label>
                  <textarea
                    id="cust_payment_notes"
                    name="payment_notes"
                    rows={2}
                    className={inputClass}
                    placeholder="לא חובה…"
                  />
                </div>
              </div>
            )}
          </div>

          {state.error && (
            <p
              role="alert"
              className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {state.error}
            </p>
          )}

          <div className="sticky bottom-0 -mx-5 mt-5 flex justify-end gap-2 border-t border-zinc-100 bg-white px-5 pt-4">
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
              {isPending ? "שומרת…" : "הוספת לקוחה"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
