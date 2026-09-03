"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { addPurchase, type AddPurchaseState } from "@/app/(app)/customers/actions";
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  RECURRENCE_LABELS,
} from "@/lib/crm/constants";

const initialState: AddPurchaseState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
const labelClass = "text-xs font-medium text-zinc-700";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// Adds a second (or third, ...) Purchase to an ALREADY-EXISTING
// customer — "הוספת שירות". Never creates another Contact/Customer/
// Lead/Touchpoint — see app/(app)/customers/actions.ts::addPurchase.
export function AddServiceDialog({ customerId }: { customerId: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(addPurchase, initialState);
  const [serviceType, setServiceType] = useState("");
  const [recordPayment, setRecordPayment] = useState(false);
  const [recurrence, setRecurrence] = useState("ONE_TIME");

  useEffect(() => {
    // Closing the dialog fires its own onClose handler below, which
    // resets the form/local state — no setState needed directly in
    // this effect body.
    if (state.success) {
      dialogRef.current?.close();
    }
  }, [state.success]);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        הוספת שירות
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => {
          formRef.current?.reset();
          setServiceType("");
          setRecordPayment(false);
          setRecurrence("ONE_TIME");
        }}
        className="w-full max-w-md rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">הוספת שירות</h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="סגירה"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          ref={formRef}
          action={formAction}
          className="max-h-[75vh] overflow-y-auto px-5 py-4"
        >
          <input type="hidden" name="customer_id" value={customerId} />

          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="svc_service_type" className={labelClass}>
                שירות *
              </label>
              <select
                id="svc_service_type"
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
              <div className="space-y-1">
                <label htmlFor="svc_custom_service_name" className={labelClass}>
                  שם השירות *
                </label>
                <input
                  id="svc_custom_service_name"
                  name="custom_service_name"
                  required
                  className={inputClass}
                  placeholder="פרטי איזה שירות"
                />
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="svc_agreed_price" className={labelClass}>
                מחיר מוסכם (₪) *
              </label>
              <input
                id="svc_agreed_price"
                name="agreed_price"
                type="number"
                min="0"
                step="1"
                required
                dir="ltr"
                className={`${inputClass} text-left`}
                placeholder="300"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="svc_recurrence" className={labelClass}>
                סוג תשלום
              </label>
              <select
                id="svc_recurrence"
                name="recurrence"
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
                className={inputClass}
              >
                <option value="ONE_TIME">{RECURRENCE_LABELS.ONE_TIME}</option>
                <option value="RECURRING_MONTHLY">{RECURRENCE_LABELS.RECURRING_MONTHLY}</option>
              </select>
              {recurrence === "RECURRING_MONTHLY" && (
                <p className="text-[11px] text-zinc-400">
                  יחויב אוטומטית כל חודש מהמחיר שהוזן למעלה, עד שייעצר ידנית.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <label htmlFor="svc_purchase_notes" className={labelClass}>
                הערות
              </label>
              <textarea
                id="svc_purchase_notes"
                name="purchase_notes"
                rows={2}
                className={inputClass}
                placeholder="לא חובה…"
              />
            </div>

            <div className="border-t border-zinc-100 pt-4">
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
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="svc_payment_amount" className={labelClass}>
                      סכום ששולם (₪) *
                    </label>
                    <input
                      id="svc_payment_amount"
                      name="payment_amount"
                      type="number"
                      min="0"
                      step="1"
                      required={recordPayment}
                      dir="ltr"
                      className={`${inputClass} text-left`}
                      placeholder="300"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="svc_payment_paid_at" className={labelClass}>
                      תאריך תשלום *
                    </label>
                    <input
                      id="svc_payment_paid_at"
                      name="payment_paid_at"
                      type="date"
                      required={recordPayment}
                      dir="ltr"
                      defaultValue={todayIso()}
                      className={`${inputClass} text-left`}
                    />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <label htmlFor="svc_payment_method" className={labelClass}>
                      אמצעי תשלום *
                    </label>
                    <select
                      id="svc_payment_method"
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
                  <div className="col-span-2 space-y-1">
                    <label htmlFor="svc_payment_notes" className={labelClass}>
                      הערות על התשלום
                    </label>
                    <textarea
                      id="svc_payment_notes"
                      name="payment_notes"
                      rows={2}
                      className={inputClass}
                      placeholder="לא חובה…"
                    />
                  </div>
                </div>
              )}
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
              {isPending ? "שומרת…" : "הוספת שירות"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
