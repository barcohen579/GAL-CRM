"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { BUSINESS_EXPENSE_CATEGORIES } from "@/lib/crm/constants";

function optionalString(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

type ParsedExpenseInput =
  | { error: string }
  | {
      expenseDate: string;
      amountMinor: number;
      category: string;
      description: string | null;
    };

// Shared by addExpense/updateExpense — same validation either way.
function parseExpenseInput(formData: FormData): ParsedExpenseInput {
  const expenseDate = optionalString(formData.get("expense_date"));
  if (!expenseDate) return { error: "יש לבחור תאריך." };

  const amountRaw = optionalString(formData.get("amount"));
  if (!amountRaw) return { error: "יש להזין סכום." };
  const amountNis = Number(amountRaw.replace(/,/g, ""));
  if (!Number.isFinite(amountNis) || amountNis < 0) {
    return { error: "הסכום שהוזן אינו תקין." };
  }
  // ₪ -> integer agorot. Never store money as a float.
  const amountMinor = Math.round(amountNis * 100);

  const category = optionalString(formData.get("category"));
  if (!category || !(BUSINESS_EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
    return { error: "יש לבחור קטגוריה." };
  }

  const description = optionalString(formData.get("description"));

  return { expenseDate, amountMinor, category, description };
}

export type ExpenseState = { error: string | null; success?: boolean };

// "הוספת הוצאה" — one action, one dialog, for BOTH "חד־פעמית" and
// "חודשית קבועה" (the `kind` field the dialog submits decides which).
// A business_expenses row (and, for a recurring one,
// business_recurring_expenses) is entirely independent of Meta spend
// (meta_campaign_daily_metrics has its own dedicated, automatically-
// synced pipeline) — neither path here can ever touch or duplicate it.
// expense_date (not created_at) is what determines which monthly
// report a ONE_TIME expense belongs to, entered explicitly by the user
// rather than defaulted to "today" — an expense is very often recorded
// a few days after the fact.
export async function addExpense(
  _prevState: ExpenseState,
  formData: FormData
): Promise<ExpenseState> {
  const parsed = parseExpenseInput(formData);
  if ("error" in parsed) return { error: parsed.error };

  const supabase = await createClient();
  const isRecurring = formData.get("kind") === "RECURRING_MONTHLY";

  if (isRecurring) {
    // Atomic: creates the recurring definition AND its first month's
    // occurrence together (see create_recurring_business_expense's own
    // comment for why this needs to be one DB transaction, not two
    // sequential requests).
    const { error } = await supabase.rpc("create_recurring_business_expense", {
      p_description: parsed.description,
      p_category: parsed.category,
      p_amount_minor: parsed.amountMinor,
      p_start_date: parsed.expenseDate,
    });
    if (error) {
      return { error: `לא הצלחנו ליצור את ההוצאה החודשית: ${error.message}` };
    }
  } else {
    const { error } = await supabase.from("business_expenses").insert({
      expense_date: parsed.expenseDate,
      amount_minor: parsed.amountMinor,
      category: parsed.category,
      description: parsed.description,
    });
    if (error) {
      return { error: `לא הצלחנו לשמור את ההוצאה: ${error.message}` };
    }
  }

  revalidatePath("/dashboard");
  return { error: null, success: true };
}

// "עריכת הוצאה" — a direct UPDATE of any field (amount/date/category/
// description). Proportionate to this data's own nature (manually
// entered, single-author, no automated-then-corrected duality like
// recurring payments have) — see the business_expenses migration's own
// comment for the full reasoning. There is deliberately no delete
// action anywhere in this codebase (no DELETE RLS policy exists on
// business_expenses at all) — expense history can only ever be
// corrected, never destroyed.
export async function updateExpense(
  _prevState: ExpenseState,
  formData: FormData
): Promise<ExpenseState> {
  const expenseId = optionalString(formData.get("expense_id"));
  if (!expenseId) return { error: "שגיאה פנימית: ההוצאה לא זוהתה." };

  const parsed = parseExpenseInput(formData);
  if ("error" in parsed) return { error: parsed.error };

  const supabase = await createClient();
  const { error } = await supabase
    .from("business_expenses")
    .update({
      expense_date: parsed.expenseDate,
      amount_minor: parsed.amountMinor,
      category: parsed.category,
      description: parsed.description,
    })
    .eq("id", expenseId);

  if (error) {
    return { error: `לא הצלחנו לעדכן את ההוצאה: ${error.message}` };
  }

  revalidatePath("/dashboard");
  return { error: null, success: true };
}

// ============================================================
// Recurring business expense management ("שינוי סכום חודשי" /
// "הפסקת הוצאה חודשית") — mirrors updateRecurringPrice /
// stopRecurringBilling in app/(app)/customers/actions.ts exactly, on
// business_recurring_expenses instead of purchases.
// ============================================================

export type UpdateRecurringExpenseState = { error: string | null; success?: boolean };

// "עריכת הוצאה קבועה" — edits the recurring DEFINITION itself
// (description/category/current monthly amount). Only ever updates
// business_recurring_expenses — never touches a single row of
// business_expenses. This is exactly why editing here is always safe
// for history: every already-generated occurrence row already has its
// own description/category/amount_minor FROZEN as plain column values
// at insert time (never a live foreign lookup back to this table), so
// no field changed here can ever rewrite a historical month, whether
// that field is the amount (affects the NEXT un-generated occurrence
// only — the recurring-billing precedent updateRecurringPrice already
// established) or description/category (this schema has no
// "presentation-only" field on business_expenses at all — every column
// is a frozen historical fact, so the same frozen-history guarantee
// applies uniformly to all three).
export async function updateRecurringExpense(
  _prevState: UpdateRecurringExpenseState,
  formData: FormData
): Promise<UpdateRecurringExpenseState> {
  const recurringExpenseId = optionalString(formData.get("recurring_expense_id"));
  if (!recurringExpenseId) return { error: "שגיאה פנימית: ההוצאה החודשית לא זוהתה." };

  const amountRaw = optionalString(formData.get("monthly_amount"));
  if (!amountRaw) return { error: "יש להזין סכום חודשי חדש." };
  const amountNis = Number(amountRaw.replace(/,/g, ""));
  if (!Number.isFinite(amountNis) || amountNis < 0) {
    return { error: "הסכום שהוזן אינו תקין." };
  }
  const amountMinor = Math.round(amountNis * 100);

  const category = optionalString(formData.get("category"));
  if (!category || !(BUSINESS_EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
    return { error: "יש לבחור קטגוריה." };
  }

  const description = optionalString(formData.get("description"));

  const supabase = await createClient();
  const { error } = await supabase
    .from("business_recurring_expenses")
    .update({ amount_minor: amountMinor, category, description })
    .eq("id", recurringExpenseId);

  if (error) {
    return { error: `לא הצלחנו לעדכן את ההוצאה הקבועה: ${error.message}` };
  }

  revalidatePath("/dashboard");
  return { error: null, success: true };
}

// "הפסקת הוצאה חודשית" — stops every FUTURE automatic occurrence.
// Never deletes or edits any existing business_expenses row — only the
// two billing-control fields move. Called directly (not a
// useActionState form action), same pattern as stopRecurringBilling,
// for a confirm-dialog button rather than a form.
export async function stopRecurringExpense(
  recurringExpenseId: string
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("business_recurring_expenses")
    .update({ status: "STOPPED", next_occurrence_date: null })
    .eq("id", recurringExpenseId);

  if (error) {
    return { error: `לא הצלחנו להפסיק את ההוצאה החודשית: ${error.message}` };
  }

  revalidatePath("/dashboard");
  return { error: null };
}
