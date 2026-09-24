// Shared vocabulary for the CRM UI — labels and visual "tone" for every
// enum defined in the database schema. Keeping this in one place means a
// stage/channel/status only ever has one label and one color anywhere in
// the app.

export type Tone =
  | "neutral"
  | "info"
  | "violet"
  | "warning"
  | "amber"
  | "success"
  | "danger";

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-zinc-100 text-zinc-700 border-zinc-200",
  info: "bg-sky-50 text-sky-700 border-sky-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  amber: "bg-orange-50 text-orange-700 border-orange-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  danger: "bg-red-50 text-red-700 border-red-200",
};

export const LEAD_STAGES = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "TRIAL_BOOKED",
  "TRIAL_COMPLETED",
  "WON",
  "LOST",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  NEW: "חדש",
  CONTACTED: "נוצר קשר",
  INTERESTED: "מתעניינת",
  TRIAL_BOOKED: "נקבע אימון ניסיון",
  TRIAL_COMPLETED: "אימון ניסיון בוצע",
  WON: "נסגרה",
  LOST: "לא נסגרה",
};

export const LEAD_STAGE_TONE: Record<LeadStage, Tone> = {
  NEW: "neutral",
  CONTACTED: "info",
  INTERESTED: "violet",
  TRIAL_BOOKED: "warning",
  TRIAL_COMPLETED: "amber",
  WON: "success",
  LOST: "danger",
};

// Selectable LOST reasons, in the owner-approved display order (see
// supabase/migrations/20260923100000_..._enum_values.sql). PRICE,
// NO_RESPONSE, CHOSE_COMPETITOR, NOT_INTERESTED and OTHER are the
// pre-V2 enum values reused for their matching new labels.
export const LEAD_LOST_REASONS = [
  "TOO_FAR",
  "PRICE",
  "SCHEDULE_MISMATCH",
  "NO_CHILDCARE",
  "NOT_INTERESTED",
  "CHOSE_COMPETITOR",
  "NO_RESPONSE",
  "START_LATER",
  "SERVICE_NOT_OFFERED",
  "NOT_A_FIT",
  "INVALID_LEAD",
  "OTHER",
] as const;

// Legacy values that may still appear on historical rows but are no
// longer offered in the UI.
export const LEGACY_LEAD_LOST_REASONS = ["TIMING"] as const;

export type LeadLostReason =
  | (typeof LEAD_LOST_REASONS)[number]
  | (typeof LEGACY_LEAD_LOST_REASONS)[number];

export const LEAD_LOST_REASON_LABELS: Record<LeadLostReason, string> = {
  TOO_FAR: "רחוקה מדי מהסטודיו",
  PRICE: "המחיר גבוה מדי",
  SCHEDULE_MISMATCH: "השעות לא מתאימות",
  NO_CHILDCARE: "אין סידור לילדים",
  NOT_INTERESTED: "לא מעוניינת כרגע",
  CHOSE_COMPETITOR: "בחרה סטודיו או מאמנת אחרת",
  NO_RESPONSE: "לא ענתה לאחר ניסיונות קשר",
  START_LATER: "רוצה להתחיל במועד מאוחר יותר",
  SERVICE_NOT_OFFERED: "מחפשת שירות שאנחנו לא מציעים",
  NOT_A_FIT: "לא מתאימה למסגרת האימונים",
  INVALID_LEAD: "פרטים שגויים / ליד לא רלוונטי",
  OTHER: "סיבה אחרת",
  TIMING: "לא הזמן המתאים",
};

export function isLeadLostReason(value: string | null | undefined): value is LeadLostReason {
  return !!value && Object.prototype.hasOwnProperty.call(LEAD_LOST_REASON_LABELS, value);
}

// Conversation outcomes (lead_conversation_outcome enum, see
// supabase/migrations/20260923101000_..._lead_workflow.sql).
export const LEAD_CONVERSATION_OUTCOMES = [
  "CALL_TOMORROW",
  "CALL_BACK_LATER",
  "WANTS_TRIAL",
  "REQUESTED_DETAILS",
  "NEEDS_TIME",
  "NUTRITION_INTEREST",
  "DETAILS_SENT_WHATSAPP",
  "NO_ANSWER",
  "OTHER",
] as const;

export type LeadConversationOutcome = (typeof LEAD_CONVERSATION_OUTCOMES)[number];

export const LEAD_CONVERSATION_OUTCOME_LABELS: Record<LeadConversationOutcome, string> = {
  CALL_TOMORROW: "להתקשר מחר",
  CALL_BACK_LATER: "לחזור אליה בתאריך אחר",
  WANTS_TRIAL: "רוצה לקבוע אימון ניסיון",
  REQUESTED_DETAILS: "ביקשה מחירים / פרטים",
  NEEDS_TIME: "צריכה זמן לחשוב",
  NUTRITION_INTEREST: "מתעניינת בליווי תזונתי",
  DETAILS_SENT_WHATSAPP: "נשלחו פרטים בוואטסאפ",
  NO_ANSWER: "לא ענתה",
  OTHER: "אחר",
};

export function isLeadConversationOutcome(value: string | null | undefined): value is LeadConversationOutcome {
  return !!value && (LEAD_CONVERSATION_OUTCOMES as readonly string[]).includes(value);
}

export const SERVICE_TYPES = [
  "GROUP_TRAINING",
  "PERSONAL_TRAINING",
  "PARTNER_TRAINING",
  "NUTRITION_COACHING",
  "ONLINE_COACHING",
  "MAMA_RESET",
  "TRIAL_GROUP",
  "TRIAL_PERSONAL",
  "OTHER",
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  GROUP_TRAINING: "אימון קבוצתי",
  PERSONAL_TRAINING: "אימון אישי",
  PARTNER_TRAINING: "אימון זוגי",
  NUTRITION_COACHING: "ליווי תזונתי",
  ONLINE_COACHING: "ליווי אונליין",
  MAMA_RESET: "MAMA RESET",
  TRIAL_GROUP: "אימון ניסיון (קבוצתי)",
  TRIAL_PERSONAL: "אימון ניסיון (אישי)",
  OTHER: "אחר",
};

export const TOUCHPOINT_CHANNELS = [
  "META_AD",
  "INSTAGRAM_ORGANIC",
  "INSTAGRAM_DM",
  "INSTAGRAM_COMMENT",
  "REFERRAL",
  "WORD_OF_MOUTH",
  "WALK_IN",
  "WEBSITE",
  "OTHER",
  "UNKNOWN",
] as const;

export type TouchpointChannel = (typeof TOUCHPOINT_CHANNELS)[number];

export const TOUCHPOINT_CHANNEL_LABELS: Record<TouchpointChannel, string> = {
  META_AD: "פרסומת במטא",
  INSTAGRAM_ORGANIC: "אינסטגרם (אורגני)",
  INSTAGRAM_DM: "הודעה באינסטגרם",
  INSTAGRAM_COMMENT: "תגובה באינסטגרם",
  REFERRAL: "הפניה מחברה",
  WORD_OF_MOUTH: "מפה לאוזן",
  WALK_IN: "הגיעה ישירות",
  WEBSITE: "אתר האינטרנט",
  OTHER: "אחר",
  UNKNOWN: "לא ידוע",
};

export const ATTRIBUTION_CERTAINTIES = ["CONFIRMED", "BROAD", "UNKNOWN"] as const;

export type AttributionCertainty = (typeof ATTRIBUTION_CERTAINTIES)[number];

export const ATTRIBUTION_CERTAINTY_LABELS: Record<AttributionCertainty, string> = {
  CONFIRMED: "מאומת",
  BROAD: "רחב",
  UNKNOWN: "לא ידוע",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PAID: "שולם",
  REFUNDED: "זוכה",
  FAILED: "נכשל",
};

export const PAYMENT_STATUS_TONE: Record<string, Tone> = {
  PAID: "success",
  REFUNDED: "neutral",
  FAILED: "danger",
};

export const PAYMENT_METHODS = [
  "CASH",
  "CARD",
  "BIT",
  "BANK_TRANSFER",
  "OTHER",
] as const;

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: "מזומן",
  CARD: "כרטיס אשראי",
  BIT: "ביט",
  BANK_TRANSFER: "העברה בנקאית",
  OTHER: "אחר",
};

export const PAYMENT_STATUSES = ["PAID", "REFUNDED", "FAILED"] as const;

// Whether a payment is linked to a Customer/Purchase or is real general
// business income with neither (see
// supabase/migrations/20260911140000_..._general_payments.sql). Shown
// as a small badge on every payment row so it's always visually clear
// which kind a row is.
export const PAYMENT_CONTEXT_LABELS: Record<string, string> = {
  CUSTOMER: "לקוחה",
  GENERAL: "כללי",
};

export const RECURRENCE_LABELS: Record<string, string> = {
  ONE_TIME: "תשלום חד פעמי",
  RECURRING_MONTHLY: "תשלום חודשי קבוע",
};

export const PURCHASE_STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "success",
  COMPLETED: "info",
  CANCELLED: "danger",
};

export const PURCHASE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "פעיל",
  COMPLETED: "הושלם",
  CANCELLED: "בוטל",
};

// Hebrew labels for a Meta campaign's real `objective` field (see
// lib/meta/campaign-sync.ts::fetchCampaignsMetadata) — shown as the
// secondary identifying line under a campaign's name in "ביצועי
// קמפיינים" so Bar/Gal can tell "איזה פרסום זה?" at a glance. Covers
// every objective observed live across both configured ad accounts,
// plus Meta's other current campaign objectives for completeness. An
// objective not listed here (Meta adds new ones over time) falls back
// to the raw value as-is — never blank, never invented.
export const OBJECTIVE_LABELS: Record<string, string> = {
  OUTCOME_ENGAGEMENT: "מעורבות",
  POST_ENGAGEMENT: "מעורבות בפוסט",
  OUTCOME_LEADS: "לידים",
  OUTCOME_TRAFFIC: "תנועה לאתר",
  LINK_CLICKS: "קליקים לקישור",
  OUTCOME_AWARENESS: "מודעות למותג",
  OUTCOME_SALES: "מכירות",
  OUTCOME_APP_PROMOTION: "קידום אפליקציה",
  MESSAGES: "הודעות",
  VIDEO_VIEWS: "צפיות בסרטון",
  CONVERSIONS: "המרות",
  REACH: "הגעה",
  BRAND_AWARENESS: "מודעות למותג",
};

export const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "פעילה",
  INACTIVE: "לא פעילה",
};

// Order matches the sequence Gal sees in the "קטגוריה" select — the
// most common studio expenses first, "אחר" always last. Extended
// beyond the original 7 (see
// supabase/migrations/20260904090000_..._recurring_business_expenses.sql
// for the ALTER TYPE ADD VALUE statements) with 5 more real categories
// a fitness-studio business needs; existing values/labels below are
// kept exactly as already stored in production rows.
export const BUSINESS_EXPENSE_CATEGORIES = [
  "RENT",
  "UTILITIES",
  "EQUIPMENT",
  "MAINTENANCE",
  "SOFTWARE_SUBSCRIPTIONS",
  "MARKETING_OTHER",
  "CONTENT_PRODUCTION",
  "PROFESSIONAL_SERVICES",
  "INSURANCE",
  "TRAINING_EDUCATION",
  "OFFICE_SUPPLIES",
  "OTHER",
] as const;

export type BusinessExpenseCategory = (typeof BUSINESS_EXPENSE_CATEGORIES)[number];

export const BUSINESS_EXPENSE_CATEGORY_LABELS: Record<BusinessExpenseCategory, string> = {
  RENT: "שכירות",
  UTILITIES: "ארנונה / חשבונות",
  EQUIPMENT: "ציוד ומכשירים",
  MAINTENANCE: "תחזוקה ותיקונים",
  SOFTWARE_SUBSCRIPTIONS: "תוכנות ומנויים",
  MARKETING_OTHER: "שיווק ופרסום אחר",
  CONTENT_PRODUCTION: "צילום / תוכן",
  PROFESSIONAL_SERVICES: 'הנהלת חשבונות / רו"ח',
  INSURANCE: "ביטוחים",
  TRAINING_EDUCATION: "הכשרות / קורסים",
  OFFICE_SUPPLIES: "ציוד משרדי / תפעולי",
  OTHER: "אחר",
};
