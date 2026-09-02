// Minimal hand-written types matching the specific query shapes used by
// the CRM UI — not a full generated schema. Kept intentionally small
// (see V1 scope decisions) rather than adding a codegen step.

import type {
  LeadStage,
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

export type LeadWithRelations = {
  id: string;
  stage: LeadStage;
  interested_service: ServiceType | null;
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
  purchase: {
    service_type: ServiceType;
    custom_service_name: string | null;
    customer: { contact: ContactSummary | null } | null;
  } | null;
};
