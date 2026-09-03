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

// "הוספת הוצאה" — a business_expenses row is entirely independent of
// Meta spend (meta_campaign_daily_metrics has its own dedicated,
// automatically-synced pipeline) — this action can never touch or
// duplicate it. expense_date (not created_at) is what determines which
// monthly report this expense belongs to, entered explicitly by the
// user rather than defaulted to "today" — an expense is very often
// recorded a few days after the fact (see the task's own September-
// entered-in-October example).
export async function addExpense(
  _prevState: ExpenseState,
  formData: FormData
): Promise<ExpenseState> {
  const parsed = parseExpenseInput(formData);
  if ("error" in parsed) return { error: parsed.error };

  const supabase = await createClient();
  const { error } = await supabase.from("business_expenses").insert({
    expense_date: parsed.expenseDate,
    amount_minor: parsed.amountMinor,
    category: parsed.category,
    description: parsed.description,
  });

  if (error) {
    return { error: `לא הצלחנו לשמור את ההוצאה: ${error.message}` };
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
