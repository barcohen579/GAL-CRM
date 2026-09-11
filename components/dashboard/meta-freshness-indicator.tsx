"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { formatRelative } from "@/lib/crm/format";

// Small, self-contained freshness indicator for the Dashboard's Meta
// spend section. The Dashboard Server Component (app/(app)/dashboard/
// page.tsx) already decided whether a background sync was JUST
// triggered (initialFreshness.isStale) via `after()` — this component's
// only job is to reflect that to Gal/Bar and, once it actually finishes,
// bring the new numbers on screen without an F5 (router.refresh()).
//
// Never shows a raw error, token, account id, or internal status word —
// only the four Hebrew states the task calls for.

type Phase = "steady" | "syncing" | "justRefreshed" | "failed";

export type InitialMetaFreshness = {
  status: "idle" | "running" | "success" | "failed";
  lastSuccessAt: string | null;
  isStale: boolean;
};

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutes — a generous ceiling before giving up quietly.

export function MetaFreshnessIndicator({
  initialFreshness,
}: {
  initialFreshness: InitialMetaFreshness;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(
    initialFreshness.status === "running" || initialFreshness.isStale ? "syncing" : "steady"
  );
  const [lastSuccessAt, setLastSuccessAt] = useState(initialFreshness.lastSuccessAt);
  const initialLastSuccessAt = useRef(initialFreshness.lastSuccessAt);
  const sawRunning = useRef(initialFreshness.status === "running");

  useEffect(() => {
    if (initialFreshness.status !== "running" && !initialFreshness.isStale) return;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (cancelled) return;
      attempts += 1;
      try {
        const res = await fetch("/api/meta/sync-status", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data.status === "running") sawRunning.current = true;

          const advanced =
            typeof data.lastSuccessAt === "string" &&
            data.lastSuccessAt !== initialLastSuccessAt.current;

          if (advanced) {
            if (cancelled) return;
            setLastSuccessAt(data.lastSuccessAt);
            setPhase("justRefreshed");
            router.refresh();
            return;
          }
          if (sawRunning.current && data.status !== "running") {
            if (cancelled) return;
            setPhase("failed");
            return;
          }
        }
      } catch {
        // Transient network hiccup while polling — try again below.
      }
      if (attempts >= MAX_POLL_ATTEMPTS) {
        if (!cancelled) setPhase((p) => (p === "justRefreshed" ? p : "failed"));
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Intentionally runs once on mount — this component's whole lifecycle
    // is "watch the one sync attempt the server-rendered props implied,
    // then stop."
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleManualRefresh() {
    setPhase("syncing");
    try {
      const res = await fetch("/api/meta/sync-trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json().catch(() => null);

      if (data?.reason === "success") {
        setPhase("justRefreshed");
        router.refresh();
        return;
      }
      if (data?.reason === "failed") {
        setPhase("failed");
        return;
      }
      // "already_running" (someone else's sync is in flight) — fall
      // through to the same polling loop the automatic trigger uses.
      sawRunning.current = true;
    } catch {
      setPhase("failed");
      return;
    }

    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const res = await fetch("/api/meta/sync-status", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (
            typeof data.lastSuccessAt === "string" &&
            data.lastSuccessAt !== initialLastSuccessAt.current
          ) {
            setLastSuccessAt(data.lastSuccessAt);
            setPhase("justRefreshed");
            router.refresh();
            return;
          }
          if (data.status !== "running") {
            setPhase("failed");
            return;
          }
        }
      } catch {
        // ignore, retry below
      }
      if (attempts < MAX_POLL_ATTEMPTS) setTimeout(poll, POLL_INTERVAL_MS);
      else setPhase("failed");
    };
    setTimeout(poll, POLL_INTERVAL_MS);
  }

  const label =
    phase === "syncing"
      ? "מעדכן נתוני Meta..."
      : phase === "justRefreshed"
        ? "נתוני Meta עודכנו עכשיו"
        : phase === "failed"
          ? "לא הצלחנו לעדכן כרגע · מוצגים הנתונים האחרונים"
          : lastSuccessAt
            ? `נתוני Meta עודכנו ${formatRelative(lastSuccessAt)}`
            : "נתוני Meta טרם עודכנו";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={
          phase === "failed"
            ? "text-amber-600"
            : phase === "syncing"
              ? "text-zinc-500"
              : "text-zinc-500"
        }
      >
        {label}
      </span>
      <button
        type="button"
        onClick={handleManualRefresh}
        disabled={phase === "syncing"}
        className="flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-1 font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw className={`h-3 w-3 ${phase === "syncing" ? "animate-spin" : ""}`} />
        רענון עכשיו
      </button>
    </div>
  );
}
