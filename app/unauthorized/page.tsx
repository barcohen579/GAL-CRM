import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";

export const metadata: Metadata = {
  title: "אין הרשאה — GAL CRM",
};

export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-zinc-50 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <ShieldAlert className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <h1 className="text-lg font-semibold text-zinc-900">
          אין הרשאת גישה
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          לחשבון הזה אין כרגע הרשאה לגישה ל-GAL CRM. התנתקנו אותך מהמערכת.
        </p>
        <Link
          href="/login"
          className="mt-5 inline-block rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700"
        >
          חזרה למסך ההתחברות
        </Link>
      </div>
    </main>
  );
}
