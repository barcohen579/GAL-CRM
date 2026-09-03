import type { Metadata } from "next";
import Link from "next/link";
import { UserRound, Phone, Mail, AtSign, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { AddCustomerDialog } from "@/components/customers/add-customer-dialog";
import {
  SERVICE_TYPE_LABELS,
  PURCHASE_STATUS_TONE,
  PURCHASE_STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatMoney, formatRelative } from "@/lib/crm/format";
import type { CustomerWithRelations } from "@/lib/crm/types";

export const metadata: Metadata = { title: "לקוחות — GAL CRM" };
export const dynamic = "force-dynamic";

type CustomerRow = CustomerWithRelations & {
  follow_up_tasks: { due_at: string; status: string }[];
};

export default async function CustomersPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("customers")
    .select(
      `id, customer_since, status,
       contact:contacts(id, full_name, phone, email, instagram_username),
       purchases(id, service_type, custom_service_name, status, recurrence, agreed_price_amount, agreed_price_currency),
       follow_up_tasks(due_at, status)`
    )
    .order("customer_since", { ascending: false });

  const customers = (data ?? []) as unknown as CustomerRow[];

  return (
    <div>
      <PageHeader
        title="לקוחות"
        description="כל מי שהפכה ללקוחה משלמת — נוצר אוטומטית כשליד נסגר, או ידנית ללקוחות קיימות."
        action={<AddCustomerDialog />}
      />

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          שגיאה בטעינת הלקוחות: {error.message}
        </p>
      )}

      {customers.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title="עדיין אין לקוחות"
          description="לקוחות יופיעו כאן אוטומטית ברגע שליד יסומן כ'נסגרה' — או שאפשר להוסיף לקוחה קיימת ידנית."
          action={<AddCustomerDialog />}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {customers.map((customer) => {
            const nextFollowUp = customer.follow_up_tasks
              .filter((t) => t.status === "PENDING")
              .sort((a, b) => a.due_at.localeCompare(b.due_at))[0];

            return (
              <Link
                key={customer.id}
                href={`/customers/${customer.id}`}
                className="block rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">
                      {customer.contact?.full_name ?? "לא ידוע"}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      לקוחה מאז {formatDate(customer.customer_since)}
                    </p>
                  </div>
                  <Badge tone={customer.status === "ACTIVE" ? "success" : "neutral"}>
                    {CUSTOMER_STATUS_LABELS[customer.status] ?? customer.status}
                  </Badge>
                </div>

                <div className="mt-3 space-y-1 text-xs text-zinc-500">
                  {customer.contact?.phone && (
                    <p className="flex items-center gap-1.5" dir="ltr">
                      <Phone className="h-3 w-3 shrink-0" /> {customer.contact.phone}
                    </p>
                  )}
                  {customer.contact?.email && (
                    <p className="flex items-center gap-1.5" dir="ltr">
                      <Mail className="h-3 w-3 shrink-0" /> {customer.contact.email}
                    </p>
                  )}
                  {customer.contact?.instagram_username && (
                    <p className="flex items-center gap-1.5" dir="ltr">
                      <AtSign className="h-3 w-3 shrink-0" />{" "}
                      {customer.contact.instagram_username}
                    </p>
                  )}
                </div>

                {customer.purchases.length > 0 && (
                  <div className="mt-4 space-y-2 border-t border-zinc-100 pt-3">
                    {customer.purchases.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="truncate text-zinc-600">
                          {p.custom_service_name ?? SERVICE_TYPE_LABELS[p.service_type]}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="font-medium text-zinc-900">
                            {formatMoney(p.agreed_price_amount, p.agreed_price_currency)}
                            {p.recurrence === "RECURRING_MONTHLY" ? " לחודש" : ""}
                          </span>
                          <Badge tone={PURCHASE_STATUS_TONE[p.status] ?? "neutral"}>
                            {PURCHASE_STATUS_LABELS[p.status] ?? p.status}
                          </Badge>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {nextFollowUp && (
                  <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-zinc-50 px-2 py-1 text-[11px] font-medium text-zinc-600">
                    <Clock className="h-3 w-3" strokeWidth={2} />
                    מעקב הבא: {formatRelative(nextFollowUp.due_at)}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
