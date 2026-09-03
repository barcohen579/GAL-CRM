// Minimal hand-written types matching the specific query shapes used by
// the CRM UI — not a full generated schema. Kept intentionally small
// (see V1 scope decisions) rather than adding a codegen step.

import type {
  LeadStage,
  LeadLostReason,
  ServiceType,
  TouchpointChannel,
} from "./constants";

export type ContactSummary = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  instagram_username: string | null;
};

export type ContactSummaryWithReferral = ContactSummary & {
  referral: ReferralInfo | null;
};

// One row in a referrer's "הפניות" list — who they referred, and
// whether that person is currently a Lead, a Customer, both, or
// neither yet (nothing prevents a referred person from having an open
// Lead AND already being a Customer from an earlier, separate deal —
// V1 shows both when present rather than picking one arbitrarily).
export type ReferralMade = {
  id: string;
  created_at: string;
  referred_contact: {
    id: string;
    full_name: string;
    leads: { id: string; stage: LeadStage }[];
    customers: { id: string; status: string } | null;
  } | null;
};

// A lead may be interested in zero, one, or several services at once
// (public.lead_interested_services) — never a single nullable value.
export type InterestedService = { service_type: ServiceType };

// "הופנתה על ידי" — present only when this Contact has a referrals row
// (public.referrals; referred_contact_id is UNIQUE, so at most one).
// referrer is null when referrer_customer_id itself is null (an
// unknown/historical referral) or the referrer's Customer row was
// later removed (ON DELETE SET NULL).
export type ReferralInfo = {
  referrer_customer_id: string | null;
  referrer: { id: string; contact: { full_name: string } | null } | null;
};

export type LeadWithRelations = {
  id: string;
  stage: LeadStage;
  interested_services: InterestedService[];
  created_at: string;
  contact: ContactSummary | null;
  touchpoints: { channel: TouchpointChannel; is_primary: boolean }[];
  follow_up_tasks: { id: string; due_at: string; status: string }[];
};

export type FollowUpWithRelations = {
  id: string;
  title: string;
  notes: string | null;
  due_at: string;
  status: "PENDING" | "COMPLETED" | "CANCELLED";
  completed_at: string | null;
  completed_note: string | null;
  source: "MANUAL" | "AI_SUGGESTED";
  lead: { id: string; stage: LeadStage; contact: ContactSummary | null } | null;
  customer: { id: string; contact: ContactSummary | null } | null;
};

export type PurchaseSummary = {
  id: string;
  service_type: ServiceType;
  custom_service_name: string | null;
  status: string;
  recurrence: string;
  agreed_price_amount: number;
  agreed_price_currency: string;
};

export type CustomerWithRelations = {
  id: string;
  customer_since: string;
  status: string;
  contact: ContactSummary | null;
  purchases: PurchaseSummary[];
};

export type PaymentWithRelations = {
  id: string;
  amount: number;
  currency: string;
  paid_at: string;
  method: string;
  status: string;
  notes: string | null;
  created_at: string;
  purchase: {
    id: string;
    service_type: ServiceType;
    custom_service_name: string | null;
    customer: { id: string; contact: ContactSummary | null } | null;
  } | null;
};

export type FollowUpTask = {
  id: string;
  title: string;
  notes: string | null;
  due_at: string;
  status: "PENDING" | "COMPLETED" | "CANCELLED";
  completed_at: string | null;
  completed_note: string | null;
  source: "MANUAL" | "AI_SUGGESTED";
  created_at: string;
  updated_at: string;
};

export type TouchpointDetail = {
  id: string;
  channel: TouchpointChannel;
  certainty: "CONFIRMED" | "BROAD" | "UNKNOWN";
  source_detail: string | null;
  is_primary: boolean;
  occurred_at: string | null;
  created_at: string;
};

export type StageEvent = {
  id: string;
  from_stage: LeadStage | null;
  to_stage: LeadStage;
  changed_at: string;
  note: string | null;
};

// Full detail shape for the /leads/[id] page.
export type LeadDetail = {
  id: string;
  stage: LeadStage;
  stage_changed_at: string;
  interested_services: InterestedService[];
  lost_reason: LeadLostReason | null;
  created_at: string;
  updated_at: string;
  contact: ContactSummaryWithReferral & { notes: string | null };
  touchpoints: TouchpointDetail[];
  follow_up_tasks: FollowUpTask[];
  stage_events: StageEvent[];
};

// Full detail shape for the /customers/[id] page.
export type CustomerDetail = {
  id: string;
  customer_since: string;
  status: string;
  contact: ContactSummaryWithReferral & { notes: string | null };
  purchases: (PurchaseSummary & {
    start_date: string;
    notes: string | null;
    lead_id: string | null;
    payments: PaymentWithRelations[];
  })[];
  follow_up_tasks: FollowUpTask[];
  // Referrals THIS customer made (referrer_customer_id = this
  // customer). Only populated on /customers/[id] — a lead never has
  // this list, and it isn't fetched from the /customers/[id] query
  // itself (see below), so it's added separately on that page.
  referralsMade?: ReferralMade[];
};

export type TimelineEventType =
  | "LEAD_CREATED"
  | "STAGE_CHANGED"
  | "TOUCHPOINT"
  | "FOLLOW_UP_CREATED"
  | "FOLLOW_UP_COMPLETED"
  | "FOLLOW_UP_CANCELLED";

export type TimelineEvent = {
  id: string;
  type: TimelineEventType;
  at: string;
  // Freeform, already-Hebrew, ready-to-render description built by the
  // caller — the timeline is a display concern assembled from real rows
  // in leads/lead_stage_events/follow_up_tasks/touchpoints, not a
  // separately stored table (see design decision in the report).
  title: string;
  description?: string;
};
