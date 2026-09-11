import type { Metadata } from "next";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import { AddPaymentDialog, type CustomerPaymentOption } from "@/components/payments/add-payment-dialog";
import {
  SERVICE_TYPE_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  PAYMENT_METHOD_LABELS,
  PAYMENT_CONTEXT_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatMoney, startOfMonthISO } from "@/lib/crm/format";
import type { PaymentWithRelations, PurchaseSummary } from "@/lib/crm/types";

export const metadata: Metadata = { title: "תשלומים — GAL CRM" };
export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const supabase = await createClient();

  const [{ data, error }, { data: customersData }] = await Promise.all([
    supabase
      .from("payments")
      .select(
        `id, amount, currency, paid_at, method, status, notes, is_auto_generated, payment_context,
         purchase:purchases(id, service_type, custom_service_name, customer:customers(id, contact:contacts(full_name)))`
      )
      .order("paid_at", { ascending: false }),
    // For the "+ הוספת תשלום" customer/purchase picker — every existing
    // Purchase per Customer, so a manual payment can only ever attach to
    // a Purchase that genuinely already exists (never auto-created).
    supabase
      .from("customers")
      .select(
        `id, contact:contacts(full_name),
         purchases(id, service_type, custom_service_name, status, recurrence, agreed_price_amount, agreed_price_currency, next_billing_date)`
      )
      .order("customer_since", { ascending: false }),
  ]);

  const payments = (data ?? []) as unknown as PaymentWithRelations[];

  const customerPaymentOptions: CustomerPaymentOption[] = (
    (customersData ?? []) as unknown as {
      id: string;
      contact: { full_name: string } | null;
      purchases: PurchaseSummary[];
    }[]
  ).map((c) => ({
    id: c.id,
    name: c.contact?.full_name ?? "לקוחה לא ידועה",
    purchases: c.purchases,
  }));

  const totalPaid = payments
    .filter((p) => p.status === "PAID")
    .reduce((sum, p) => sum + p.amount, 0);
  const totalRefunded = payments
    .filter((p) => p.status === "REFUNDED")
    .reduce((sum, p) => sum + p.amount, 0);

  const monthStart = startOfMonthISO().slice(0, 10);
  const totalThisMonth = payments
    .filter((p) => p.status === "PAID" && p.paid_at >= monthStart)
    .reduce((sum, p) => sum + p.amount, 0);

  return (
    <div>
      <PageHeader
        title="תשלומים"
        description="יומן ההכנסות — כל תשלום שנרשם אי פעם, מהחדש לישן."
        action={<AddPaymentDialog customers={customerPaymentOptions} />}
      />

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          שגיאה בטעינת התשלומים: {error.message}
        </p>
      )}

      <div className="mb-6 grid grid-cols-3 gap-4 sm:max-w-xl">
        <StatCard
          label="התקבל החודש"
          value={formatMoney(totalThisMonth)}
          icon={Wallet}
          tone="accent"
        />
        <StatCard label="סה״כ נגבה" value={formatMoney(totalPaid)} icon={Wallet} />
        <StatCard label="סה״כ זוכה" value={formatMoney(totalRefunded)} icon={Wallet} />
      </div>

      {payments.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="עדיין לא נרשמו תשלומים"
          description="תשלומים יופיעו כאן ברגע שתירשם הכנסה מול רכישה של לקוחה."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <ul className="divide-y divide-zinc-100">
            {payments.map((payment) => (
              <li
                key={payment.id}
                className="flex items-center justify-between gap-4 px-5 py-3.5"
              >
                <div className="min-w-0">
                  {payment.payment_context === "GENERAL" ? (
                    <>
                      <p className="truncate text-sm font-medium text-zinc-900">{payment.notes}</p>
                      <p className="truncate text-xs text-zinc-500">
                        {formatDate(payment.paid_at)}
                        {" · "}
                        {PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {payment.purchase?.custom_service_name ??
                          (payment.purchase
                            ? SERVICE_TYPE_LABELS[payment.purchase.service_type]
                            : "שירות לא ידוע")}
                      </p>
                      <p className="truncate text-xs text-zinc-500">
                        {payment.purchase?.customer ? (
                          <Link
                            href={`/customers/${payment.purchase.customer.id}`}
                            className="hover:text-rose-600 hover:underline"
                          >
                            {payment.purchase.customer.contact?.full_name ?? "לקוחה לא ידועה"}
                          </Link>
                        ) : (
                          "לקוחה לא ידועה"
                        )}
                        {" · "}
                        {formatDate(payment.paid_at)}
                        {" · "}
                        {PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}
                      </p>
                    </>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900">
                    {formatMoney(payment.amount, payment.currency)}
                  </span>
                  <Badge tone={payment.payment_context === "GENERAL" ? "neutral" : "info"}>
                    {PAYMENT_CONTEXT_LABELS[payment.payment_context] ?? payment.payment_context}
                  </Badge>
                  <Badge tone={PAYMENT_STATUS_TONE[payment.status] ?? "neutral"}>
                    {PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}
                  </Badge>
                  {payment.is_auto_generated && <Badge tone="info">אוטומטי</Badge>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
