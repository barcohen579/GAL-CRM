import type { Metadata } from "next";
import { Dumbbell } from "lucide-react";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "כניסה — GAL CRM",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-zinc-50 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-600 text-white shadow-sm shadow-rose-200">
            <Dumbbell className="h-5 w-5" strokeWidth={2.25} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-zinc-900">
              כניסה ל-GAL CRM
            </h1>
            <p className="text-sm text-zinc-500">התחברי כדי להמשיך</p>
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
