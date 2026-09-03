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

export const LEAD_LOST_REASONS = [
  "PRICE",
  "TIMING",
  "NO_RESPONSE",
  "CHOSE_COMPETITOR",
  "NOT_INTERESTED",
  "OTHER",
] as const;

export type LeadLostReason = (typeof LEAD_LOST_REASONS)[number];

export const LEAD_LOST_REASON_LABELS: Record<LeadLostReason, string> = {
  PRICE: "המחיר לא התאים",
  TIMING: "לא הזמן המתאים",
  NO_RESPONSE: "לא הגיבה יותר",
  CHOSE_COMPETITOR: "בחרה מקום אחר",
  NOT_INTERESTED: "לא הייתה מעוניינת",
  OTHER: "אחר",
};

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

export const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "פעילה",
  INACTIVE: "לא פעילה",
};
