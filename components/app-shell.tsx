"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Clock,
  UserRound,
  Wallet,
  LogOut,
  Menu,
  X,
  Dumbbell,
} from "lucide-react";
import { logout } from "@/app/(app)/actions";

const NAV_ITEMS = [
  { href: "/dashboard", label: "לוח בקרה", icon: LayoutDashboard },
  { href: "/leads", label: "לידים", icon: Users },
  { href: "/follow-ups", label: "מעקבים", icon: Clock },
  { href: "/customers", label: "לקוחות", icon: UserRound },
  { href: "/payments", label: "תשלומים", icon: Wallet },
] as const;

export function AppShell({
  fullName,
  overdueFollowUps,
  children,
}: {
  fullName: string;
  overdueFollowUps: number;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  const nav = (
    <nav className="flex flex-1 flex-col gap-1 px-3">
      {NAV_ITEMS.map((item) => {
        const active = pathname?.startsWith(item.href);
        const Icon = item.icon;
        const badge =
          item.href === "/follow-ups" && overdueFollowUps > 0
            ? overdueFollowUps
            : null;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={`group flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
              active
                ? "bg-rose-50 text-rose-700"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
          >
            <span className="flex items-center gap-3">
              <Icon
                className={`h-[18px] w-[18px] ${
                  active ? "text-rose-600" : "text-zinc-400 group-hover:text-zinc-600"
                }`}
                strokeWidth={2}
              />
              {item.label}
            </span>
            {badge && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-4 py-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-600 text-white shadow-sm shadow-rose-200">
        <Dumbbell className="h-[18px] w-[18px]" strokeWidth={2.25} />
      </div>
      <div>
        <p className="text-sm font-semibold leading-tight text-zinc-900">
          GAL CRM
        </p>
        <p className="text-[11px] leading-tight text-zinc-400">
          Gal Valdman Fitness
        </p>
      </div>
    </div>
  );

  const userFooter = (
    <div className="border-t border-zinc-100 p-3">
      <div className="flex items-center gap-3 rounded-xl px-2 py-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
          {fullName.slice(0, 1).toUpperCase()}
        </div>
        <p className="flex-1 truncate text-sm font-medium text-zinc-700">
          {fullName}
        </p>
        <form action={logout}>
          <button
            type="submit"
            aria-label="התנתקות"
            title="התנתקות"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            <LogOut className="h-4 w-4" strokeWidth={2} />
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 md:flex">
      {/* Desktop sidebar — sits at the inline-start edge, which is the
          RIGHT side under dir="rtl". border-e (not border-r) so the
          separating line stays on whichever side actually touches the
          main content, regardless of direction. */}
      <aside className="hidden w-64 shrink-0 flex-col border-e border-zinc-200 bg-white md:flex">
        {brand}
        {nav}
        {userFooter}
      </aside>

      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 md:hidden">
        {brand}
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="פתיחת תפריט"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {/* Mobile drawer — start-0 (not left-0) so it opens from the RIGHT
          under dir="rtl". */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            aria-label="סגירת תפריט"
            className="absolute inset-0 bg-zinc-900/40"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 start-0 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between pe-2">
              {brand}
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="סגירת תפריט"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {nav}
            {userFooter}
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}
