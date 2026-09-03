import type { Metadata } from "next";
import { Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { AddLeadDialog } from "@/components/leads/add-lead-dialog";
import { LeadCard } from "@/components/leads/lead-card";
import { LEAD_STAGES, LEAD_STAGE_LABELS, LEAD_STAGE_TONE } from "@/lib/crm/constants";
import type { LeadWithRelations } from "@/lib/crm/types";

export const metadata: Metadata = { title: "לידים — GAL CRM" };
export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  const { deleted } = await searchParams;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("leads")
    .select(
      `id, stage, created_at,
       interested_services:lead_interested_services(service_type),
       contact:contacts(id, full_name, phone, email, instagram_username),
       touchpoints(channel, is_primary),
       follow_up_tasks(id, due_at, status)`
    )
    .order("created_at", { ascending: false });

  const leads = (data ?? []) as unknown as LeadWithRelations[];

  const byStage = Object.fromEntries(
    LEAD_STAGES.map((stage) => [
      stage,
      leads.filter((l) => l.stage === stage),
    ])
  ) as Record<(typeof LEAD_STAGES)[number], LeadWithRelations[]>;

  return (
    <div>
      <PageHeader
        title="לידים"
        description="כל פנייה, מהמגע הראשון ועד שנסגרה או לא נסגרה."
        action={<AddLeadDialog />}
      />

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          שגיאה בטעינת הלידים: {error.message}
        </p>
      )}

      {deleted === "1" && (
        <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          הליד נמחק בהצלחה.
        </p>
      )}

      {leads.length === 0 ? (
        <EmptyState
          icon={Users}
          title="עדיין אין לידים"
          description="הוסיפי את הליד הראשון כדי להתחיל לבנות את הפייפליין."
          action={<AddLeadDialog />}
        />
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {LEAD_STAGES.map((stage) => (
            <div key={stage} className="w-72 shrink-0">
              <div className="mb-3 flex items-center justify-between px-1">
                <Badge tone={LEAD_STAGE_TONE[stage]}>
                  {LEAD_STAGE_LABELS[stage]}
                </Badge>
                <span className="text-xs font-medium text-zinc-400">
                  {byStage[stage].length}
                </span>
              </div>
              <div className="flex flex-col gap-2.5 rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/60 p-2.5 min-h-[120px]">
                {byStage[stage].length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-zinc-400">
                    אין לידים בשלב הזה
                  </p>
                ) : (
                  byStage[stage].map((lead) => (
                    <LeadCard key={lead.id} lead={lead} />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
