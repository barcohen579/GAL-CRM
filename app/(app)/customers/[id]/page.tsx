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
import { MarkPaymentUnpaidButton } from "@/components/payments/mark-payment-unpaid-button";
import { AddServiceDialog } from "@/components/customers/add-service-dialog";
import { EditContactDialog } from "@/components/customers/edit-contact-dialog";
import { EnableRecurringDialog } from "@/components/customers/enable-recurring-dialog";
import { StopRecurringButton } from "@/components/customers/stop-recurring-button";
import { UpdateRecurringPriceDialog } from "@/components/customers/update-recurring-price-dialog";
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
import { CalendarClock, Wallet, Users } from "lucide-react";
import { LEAD_STAGE_LABELS, LEAD_STAGE_TONE } from "@/lib/crm/constants";
import { computeReferralMetrics } from "@/lib/crm/referrals";
import type { CustomerDetail, ReferralMade } from "@/lib/crm/types";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "לקוחה — GAL CRM" };
}

export default async function CustomerDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; converted?: string }>;
}) {
  const { id } = await params;
  const { created, converted } = await searchParams;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("customers")
    .select(
      `id, customer_since, status,
       contact:contacts(id, full_name, phone, email, instagram_username, notes,
         referral:referrals(
           referrer_customer_id,
           referrer:customers(id, contact:contacts(full_name))
         )
       ),
       purchases(id, service_type, custom_service_name, status, recurrence, agreed_price_amount, agreed_price_currency, start_date, notes, lead_id, next_billing_date,
         payments(id, amount, currency, paid_at, method, status, notes, created_at, is_auto_generated)),
       follow_up_tasks(id, title, notes, due_at, status, completed_at, completed_note, source, created_at, updated_at)`
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !data || !data.contact) {
    notFound();
  }

  const customer = data as unknown as CustomerDetail;

  // "הפניות" — people THIS customer referred (referrer_customer_id = this
  // customer's id). Separate query: not part of the row above, and only
  // ever needed on the referrer's own page.
  const { data: referralsMadeData } = await supabase
    .from("referrals")
    .select(
      `id, created_at,
       referred_contact:contacts(
         id, full_name,
         leads(id, stage),
         customers(id, status)
       )`
    )
    .eq("referrer_customer_id", customer.id)
    .order("created_at", { ascending: false });

  const referralsMade = (referralsMadeData ?? []) as unknown as ReferralMade[];

  const referredCustomerIds = referralsMade
    .map((r) => r.referred_contact?.customers?.id)
    .filter((cid): cid is string => Boolean(cid));

  // Revenue from people this customer referred — direct only (their own
  // paid payments), never recursive through further referrals of theirs.
  // Deliberately not framed as LTV: just what's been paid so far. The
  // aggregation itself (computeReferralMetrics) is a pure, unit-tested
  // function — this query only scopes purchases to the referred
  // customers, mirroring lib/crm/marketing.ts's fetch/compute split.
  let referredPurchasesRows: { payments: { amount: number; status: string }[] }[] = [];
  if (referredCustomerIds.length > 0) {
    const { data: referredPurchases } = await supabase
      .from("purchases")
      .select("payments(amount, status)")
      .in("customer_id", referredCustomerIds);
    referredPurchasesRows = referredPurchases ?? [];
  }

  const referralMetrics = computeReferralMetrics(referralsMade, referredPurchasesRows);

  const allPurchasesSimplified = customer.purchases.map((p) => ({
    id: p.id,
    service_type: p.service_type,
    custom_service_name: p.custom_service_name,
    status: p.status,
    recurrence: p.recurrence,
    agreed_price_amount: p.agreed_price_amount,
    agreed_price_currency: p.agreed_price_currency,
    next_billing_date: p.next_billing_date,
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

      {converted === "1" && (
        <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          הליד נסגר בהצלחה. אם היא רכשה עוד שירות, אפשר להוסיף אותו כאן.
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
            <CardHeader
              title="פרטי הלקוחה"
              action={
                <EditContactDialog
                  contactId={customer.contact.id}
                  customerId={customer.id}
                  fullName={customer.contact.full_name}
                  phone={customer.contact.phone}
                  email={customer.contact.email}
                  instagramUsername={customer.contact.instagram_username}
                />
              }
            />
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
              {customer.contact.referral && (
                <div>
                  <p className="text-xs font-medium text-zinc-500">הופנתה על ידי</p>
                  <p className="mt-0.5 text-sm text-zinc-800">
                    {customer.contact.referral.referrer ? (
                      <Link
                        href={`/customers/${customer.contact.referral.referrer.id}`}
                        className="text-rose-600 hover:underline"
                      >
                        {customer.contact.referral.referrer.contact?.full_name ?? "לקוחה"}
                      </Link>
                    ) : (
                      "הפניה (לא ידוע על ידי מי)"
                    )}
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
                <div className="flex items-center gap-2">
                  <AddServiceDialog customerId={customer.id} />
                  <RecordPaymentDialog
                    customerId={customer.id}
                    purchases={allPurchasesSimplified}
                  />
                </div>
              }
            />
            {customer.purchases.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-zinc-400">
                אין עדיין רכישות רשומות.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {customer.purchases.map((p) => {
                  const serviceLabel = p.custom_service_name ?? SERVICE_TYPE_LABELS[p.service_type];
                  const isActivelyRecurring =
                    p.recurrence === "RECURRING_MONTHLY" &&
                    p.status === "ACTIVE" &&
                    Boolean(p.next_billing_date);
                  const canEnableRecurring =
                    !isActivelyRecurring && (p.status === "ACTIVE" || p.status === "CANCELLED");
                  const currentAmountNis = p.agreed_price_amount / 100;

                  return (
                    <li key={p.id} className="px-5 py-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-900">
                            {serviceLabel}
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

                      {isActivelyRecurring && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2.5">
                          <span className="text-xs font-medium text-emerald-700">
                            פעיל — {formatMoney(p.agreed_price_amount, p.agreed_price_currency)}{" "}
                            לחודש
                          </span>
                          <span className="text-[11px] text-zinc-400">
                            חיוב הבא: {formatDate(p.next_billing_date!)}
                          </span>
                          <span className="mr-auto flex items-center gap-2">
                            <UpdateRecurringPriceDialog
                              purchaseId={p.id}
                              customerId={customer.id}
                              currentAmountNis={currentAmountNis}
                            />
                            <StopRecurringButton
                              purchaseId={p.id}
                              customerId={customer.id}
                              serviceLabel={serviceLabel}
                            />
                          </span>
                        </div>
                      )}

                      {canEnableRecurring && (
                        <div className="mt-2.5 border-t border-zinc-100 pt-2.5">
                          <EnableRecurringDialog
                            purchaseId={p.id}
                            customerId={customer.id}
                            currentAmountNis={currentAmountNis}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
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
                      {pay.status === "PAID" && (
                        <div className="mt-1">
                          <MarkPaymentUnpaidButton paymentId={pay.id} customerId={customer.id} />
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-zinc-900">
                          {formatMoney(pay.amount, pay.currency)}
                        </span>
                        <Badge tone={PAYMENT_STATUS_TONE[pay.status] ?? "neutral"}>
                          {PAYMENT_STATUS_LABELS[pay.status] ?? pay.status}
                        </Badge>
                      </div>
                      {pay.is_auto_generated && <Badge tone="info">אוטומטי</Badge>}
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

          {referralsMade.length > 0 && (
            <Card className="mt-6">
              <CardHeader
                title="הפניות"
                description={`${referralMetrics.referredCount} הופנו · ${referralMetrics.becameCustomerCount} הפכו ללקוחות · הכנסות מלקוחות שהופנו: ${formatMoney(referralMetrics.revenueMinor)}`}
              />
              <ul className="divide-y divide-zinc-100">
                {referralsMade.map((r) => {
                  const contact = r.referred_contact;
                  if (!contact) return null;
                  const lead = contact.leads[0];
                  const isCustomer = Boolean(contact.customers);
                  return (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Users className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                        <Link
                          href={
                            isCustomer && contact.customers
                              ? `/customers/${contact.customers.id}`
                              : lead
                                ? `/leads/${lead.id}`
                                : "#"
                          }
                          className="truncate text-sm font-medium text-zinc-900 hover:text-rose-600 hover:underline"
                        >
                          {contact.full_name}
                        </Link>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {isCustomer && <Badge tone="success">לקוחה</Badge>}
                        {lead && !isCustomer && (
                          <Badge tone={LEAD_STAGE_TONE[lead.stage]}>
                            {LEAD_STAGE_LABELS[lead.stage]}
                          </Badge>
                        )}
                        {!lead && !isCustomer && <Badge tone="neutral">איש קשר</Badge>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
