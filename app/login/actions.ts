"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error: string | null };

export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "יש להזין אימייל וסיסמה." };
  }

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return { error: "המערכת עדיין לא הוגדרה. יש לפנות למנהלת המערכת." };
  }

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // Deliberately generic — never reveal whether the email exists.
    return { error: "אימייל או סיסמה שגויים." };
  }

  // Authorization (public.app_users / is_active) is checked separately,
  // by the protected page itself via getCrmUser() — not here. A
  // successful Supabase Auth login just means we hand off to /dashboard,
  // which will redirect on to /unauthorized if the account isn't an
  // active CRM user.
  redirect("/dashboard");
}
