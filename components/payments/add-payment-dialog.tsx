"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { recordPayment, type RecordPaymentState } from "@/app/(app)/payments/actions";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  SERVICE_TYPE_LABELS,
  PURCHASE_STATUS_LABELS,
} from "@/lib/crm/constants";
import type { PurchaseSummary } from "@/lib/crm/types";

// General-purpose "+ הוספת תשלום" entry point for /payments — for real
// payments that never went through the WON-conversion flow (cash, Bit,
// bank transfer, a manually entered card payment, or a historical
// backfill). Deliberately a SEPARATE component from
// components/payments/record-payment-dialog.tsx (which stays scoped to
// a single already-known customer on /customers/[id], unchanged) rather
// than generalizing that proven component — this one adds a customer
// picker in front of the same fields, then submits through the exact
// SAME recordPayment Server Action (app/(app)/payments/actions.ts) —
// the one authoritative write path, reused, not duplicated. That action
// now also verifies the submitted purchase genuinely belongs to the
// submitted customer (lib/crm/payments.ts::validatePurchaseOwnership)
// before ever inserting.
//
// Also supports a second payment type — "תשלום כללי" (GENERAL): real
// PAID revenue not tied to any Customer/Purchase (a one-off workshop,
// event income, ...). Toggling to it removes the customer/purchase
// pickers entirely (not just hides them — avoids any `required`-
// attribute conflict) and makes the notes field a required description,
// same recordPayment action, branching server-side on payment_context.

const initialState: RecordPaymentState = { error: null };

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
const labelClass = "text-xs font-medium text-zinc-700";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export type CustomerPaymentOption = {
  id: string;
  name: string;
  purchases: PurchaseSummary[];
};

function purchaseLabel(p: PurchaseSummary): string {
  const service = p.custom_service_name ?? SERVICE_TYPE_LABELS[p.service_type];
  return p.status === "ACTIVE" ? service : `${service} (${PURCHASE_STATUS_LABELS[p.status] ?? p.status})`;
}

type PaymentType = "CUSTOMER" | "GENERAL";

export function AddPaymentDialog({ customers }: { customers: CustomerPaymentOption[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(recordPayment, initialState);

  const [paymentType, setPaymentType] = useState<PaymentType>("CUSTOMER");
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  const purchases = selectedCustomer?.purchases ?? [];
  const [purchaseId, setPurchaseId] = useState(purchases[0]?.id ?? "");

  // Re-defaulting the purchase picker happens directly in the customer
  // select's own onChange below (an event handler, not an effect) —
  // never leave a stale purchase_id from a DIFFERENT customer sitting
  // selected (that's exactly what validatePurchaseOwnership guards
  // against server-side too, defense in depth).
  function handleCustomerChange(newCustomerId: string) {
    setCustomerId(newCustomerId);
    const nextCustomer = customers.find((c) => c.id === newCustomerId);
    setPurchaseId(nextCustomer?.purchases[0]?.id ?? "");
  }

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      dialogRef.current?.close();
    }
  }, [state.success]);

  // Deliberately NOT `if (customers.length === 0) return null` anymore —
  // a GENERAL payment needs no Customer to exist at all. CUSTOMER mode
  // shows its own inline message when there are none (below).

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700"
      >
        <Plus className="h-4 w-4" strokeWidth={2.5} />
        הוספת תשלום
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => formRef.current?.reset()}
        className="w-full max-w-md rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">הוספת תשלום</h2>
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
          <input type="hidden" name="payment_context" value={paymentType} />
          {paymentType === "CUSTOMER" && <input type="hidden" name="customer_id" value={customerId} />}

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-zinc-100 p-1 text-sm">
              <button
                type="button"
                onClick={() => setPaymentType("CUSTOMER")}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                  paymentType === "CUSTOMER" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700"
                }`}
              >
                תשלום של לקוחה
              </button>
              <button
                type="button"
                onClick={() => setPaymentType("GENERAL")}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                  paymentType === "GENERAL" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700"
                }`}
              >
                תשלום כללי
              </button>
            </div>

            {paymentType === "CUSTOMER" ? (
              <>
                <div className="space-y-1">
                  <label htmlFor="add_payment_customer" className={labelClass}>
                    לקוחה *
                  </label>
                  {customers.length === 0 ? (
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      אין עדיין לקוחות במערכת.
                    </p>
                  ) : (
                    <select
                      id="add_payment_customer"
                      required
                      value={customerId}
                      onChange={(e) => handleCustomerChange(e.target.value)}
                      className={inputClass}
                    >
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="space-y-1">
                  <label htmlFor="purchase_id" className={labelClass}>
                    רכישה *
                  </label>
                  {purchases.length === 0 ? (
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      ללקוחה זו אין רכישות קיימות לשיוך תשלום — יש להוסיף רכישה קודם.
                    </p>
                  ) : (
                    <select
                      id="purchase_id"
                      name="purchase_id"
                      required
                      value={purchaseId}
                      onChange={(e) => setPurchaseId(e.target.value)}
                      className={inputClass}
                    >
                      {purchases.map((p) => (
                        <option key={p.id} value={p.id}>
                          {purchaseLabel(p)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </>
            ) : (
              <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
                תשלום כללי אינו משויך ללקוחה או לרכישה ספציפית — יש לתאר אותו למטה.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="add_payment_amount" className={labelClass}>
                  סכום (₪) *
                </label>
                <input
                  id="add_payment_amount"
                  name="amount"
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
                <label htmlFor="add_payment_paid_at" className={labelClass}>
                  תאריך תשלום *
                </label>
                <input
                  id="add_payment_paid_at"
                  name="paid_at"
                  type="date"
                  required
                  dir="ltr"
                  defaultValue={todayIso()}
                  className={`${inputClass} text-left`}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="add_payment_method" className={labelClass}>
                  אמצעי תשלום *
                </label>
                <select id="add_payment_method" name="method" required defaultValue="" className={inputClass}>
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
              <div className="space-y-1">
                <label htmlFor="add_payment_status" className={labelClass}>
                  סטטוס
                </label>
                <select id="add_payment_status" name="status" defaultValue="PAID" className={inputClass}>
                  <option value="PAID">שולם</option>
                  <option value="REFUNDED">זוכה</option>
                  <option value="FAILED">נכשל</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="add_payment_notes" className={labelClass}>
                {paymentType === "GENERAL" ? "תיאור *" : "הערות"}
              </label>
              <textarea
                id="add_payment_notes"
                name="notes"
                rows={2}
                required={paymentType === "GENERAL"}
                className={inputClass}
                placeholder={
                  paymentType === "GENERAL"
                    ? "לדוגמה: סדנה חד-פעמית, הכנסה מאירוע"
                    : "פרטים נוספים…"
                }
              />
            </div>
          </div>

          {state.error && (
            <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
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
              disabled={
                isPending ||
                (paymentType === "CUSTOMER" && (customers.length === 0 || purchases.length === 0))
              }
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-60"
            >
              {isPending ? "שומרת…" : "שמירת תשלום"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
