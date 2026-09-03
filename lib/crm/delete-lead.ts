// Pure result-mapping logic for the deleteLead Server Action
// (app/(app)/leads/actions.ts). Extracted out of that "use server" file
// specifically so it can be unit-tested directly — Next.js requires
// every export of a "use server" file to be an async Server Action, so
// a plain synchronous helper can't live there. See
// lib/meta/ingest.ts::sanitizeErrorMessage for the same pattern
// already used elsewhere in this project.

// Postgres SQLSTATE the delete_lead_safely() RPC raises specifically
// when the contact has customer/purchase history that must be
// preserved — see supabase/migrations/20260903101406_...sql. Checked
// by code, not by matching the (English) exception message text, so
// this stays correct even if that message's wording changes later.
export const BLOCKED_HAS_HISTORY_SQLSTATE = "GALB1";

export type DeleteLeadRpcError = { code?: string | null; message: string } | null;

// Returns the Hebrew message to show the user, or null when there was
// no error (the caller should then treat the deletion as successful).
export function classifyDeleteLeadError(error: DeleteLeadRpcError): string | null {
  if (!error) return null;

  if (error.code === BLOCKED_HAS_HISTORY_SQLSTATE) {
    return "לא ניתן למחוק ליד זה: איש הקשר כבר הפך ללקוחה, עם היסטוריית רכישות/תשלומים שיש לשמור.";
  }

  return `לא הצלחנו למחוק את הליד: ${error.message}`;
}
