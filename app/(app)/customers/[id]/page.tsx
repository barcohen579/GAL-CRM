import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Phone, Mail, AtSign } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { CreateFollowUpDialog } from "@/components/follow-ups/create-follow-up-dialog";
import { FollowUpTaskActions } from "@/components/follow-ups/follow-up-task-actions";
import { RecordPaymentDialog } from "@/components/payments/record-payment-dialog";
import {
  SERVICE_TYPE_LABELS,
  PURCHASE_STATUS_TONE,
  PURCHASE_STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  PAYMENT_METHOD_LABELS,
  RECURRENCE_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatDateTime, formatMoney } from "@/lib/crm/format";
import { CalendarClock, Wallet } from "lucide-react";
import type { CustomerDetail } from "@/lib/crm/types";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "לקוחה — GAL CRM" };
}

export default async function CustomerDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { id } = await params;
  const { created } = await searchParams;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("customers")
    .select(
      `id, customer_since, status,
       contact:contacts(id, full_name, phone, email, instagram_username, notes),
       purchases(id, service_type, custom_service_name, status, recurrence, agreed_price_amount, agreed_price_currency, start_date, notes, lead_id,
         payments(id, amount, currency, paid_at, method, status, notes, created_at)),
       follow_up_tasks(id, title, notes, due_at, status, completed_at, completed_note, source, created_at, updated_at)`
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !data || !data.contact) {
    notFound();
  }

  const customer = data as unknown as CustomerDetail;

  const allPurchasesSimplified = customer.purchases.map((p) => ({
    id: p.id,
    service_type: p.service_type,
    custom_service_name: p.custom_service_name,
    status: p.status,
    recurrence: p.recurrence,
    agreed_price_amount: p.agreed_price_amount,
    agreed_price_currency: p.agreed_price_currency,
  }));

  const allPayments = customer.purchases
    .flatMap((p) =>
      p.payments.map((pay) => ({
        ...pay,
        serviceLabel: p.custom_service_name ?? SERVICE_TYPE_LABELS[p.service_type],
      }))
    )
    .sort((a, b) => b.paid_at.localeCompare(a.paid_at));

  const pendingFollowUps = customer.follow_up_tasks
    .filter((t) => t.status === "PENDING")
    .sort((a, b) => a.due_at.localeCompare(b.due_at));

  return (
    <div>
      <Link
        href="/customers"
        className="mb-4 flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-rose-600"
      >
        <ArrowRight className="h-3.5 w-3.5" />
        חזרה ללקוחות
      </Link>

      {created === "1" && (
        <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          הלקוחה נוספה בהצלחה.
        </p>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          {customer.contact.full_name}
        </h1>
        <Badge tone={customer.status === "ACTIVE" ? "success" : "neutral"}>
          {CUSTOMER_STATUS_LABELS[customer.status] ?? customer.status}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="פרטי הלקוחה" />
            <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-zinc-500">לקוחה מאז</p>
                <p className="mt-0.5 text-sm text-zinc-800">
                  {formatDate(customer.customer_since)}
                </p>
              </div>
              {customer.contact.phone && (
                <div>
                  <p className="text-xs font-medium text-zinc-500">טלפון</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm text-zinc-800" dir="ltr">
                    <Phone className="h-3.5 w-3.5 text-zinc-400" />
                    {customer.contact.phone}
                  </p>
                </div>
              )}
              {customer.contact.email && (
                <div>
                  <p className="text-xs font-medium text-zinc-500">אימייל</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm text-zinc-800" dir="ltr">
                    <Mail className="h-3.5 w-3.5 text-zinc-400" />
                    {customer.contact.email}
                  </p>
                </div>
              )}
              {customer.contact.instagram_username && (
                <div>
                  <p className="text-xs font-medium text-zinc-500">אינסטגרם</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm text-zinc-800" dir="ltr">
                    <AtSign className="h-3.5 w-3.5 text-zinc-400" />
                    {customer.contact.instagram_username}
                  </p>
                </div>
              )}
            </div>
            {customer.contact.notes && (
              <div className="border-t border-zinc-100 px-5 py-4">
                <p className="mb-1.5 text-xs font-medium text-zinc-500">הערות</p>
                <p className="whitespace-pre-wrap text-sm text-zinc-700">
                  {customer.contact.notes}
                </p>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="רכישות"
              action={
                <RecordPaymentDialog
                  customerId={customer.id}
                  purchases={allPurchasesSimplified}
                />
              }
            />
            {customer.purchases.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-zinc-400">
                אין עדיין רכישות רשומות.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {customer.purchases.map((p) => (
                  <li key={p.id} className="px-5 py-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-900">
                          {p.custom_service_name ?? SERVICE_TYPE_LABELS[p.service_type]}
                        </p>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {formatMoney(p.agreed_price_amount, p.agreed_price_currency)}
                          {" · "}
                          {RECURRENCE_LABELS[p.recurrence] ?? p.recurrence}
                          {" · "}
                          החל מ-{formatDate(p.start_date)}
                          {p.lead_id && (
                            <>
                              {" · "}
                              <Link
                                href={`/leads/${p.lead_id}`}
                                className="text-rose-600 hover:underline"
                              >
                                הליד המקורי
                              </Link>
                            </>
                          )}
                        </p>
                      </div>
                      <Badge tone={PURCHASE_STATUS_TONE[p.status] ?? "neutral"}>
                        {PURCHASE_STATUS_LABELS[p.status] ?? p.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="תשלומים" />
            {allPayments.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={Wallet}
                  title="אין עדיין תשלומים"
                  description='ניתן לרשום תשלום דרך "רישום תשלום" בכרטיס הרכישות.'
                />
              </div>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {allPayments.map((pay) => (
                  <li key={pay.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {pay.serviceLabel}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {formatDate(pay.paid_at)} ·{" "}
                        {PAYMENT_METHOD_LABELS[pay.method] ?? pay.method}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-900">
                        {formatMoney(pay.amount, pay.currency)}
                      </span>
                      <Badge tone={PAYMENT_STATUS_TONE[pay.status] ?? "neutral"}>
                        {PAYMENT_STATUS_LABELS[pay.status] ?? pay.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader
              title="מעקבים"
              action={<CreateFollowUpDialog customerId={customer.id} />}
            />
            {pendingFollowUps.length === 0 ? (
              <div className="p-5">
                <EmptyState icon={CalendarClock} title="אין מעקב פתוח" />
              </div>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {pendingFollowUps.map((task) => {
                  const overdue = new Date(task.due_at) < new Date();
                  return (
                    <li key={task.id} className="px-5 py-3">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {task.title}
                      </p>
                      <p
                        className={`mt-1 text-xs font-medium ${overdue ? "text-red-600" : "text-zinc-500"}`}
                      >
                        {overdue ? "באיחור: " : ""}
                        {formatDateTime(task.due_at)}
                      </p>
                      <div className="mt-2">
                        <FollowUpTaskActions taskId={task.id} customerId={customer.id} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
