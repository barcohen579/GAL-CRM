"use client";

import { useRef, useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { changeLeadStage } from "@/app/(app)/leads/actions";
import { LostReasonDialog } from "./lost-reason-dialog";
import { WonConversionDialog } from "./won-conversion-dialog";
import { Badge } from "@/components/ui/badge";
import {
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_TONE,
  type LeadStage,
} from "@/lib/crm/constants";

// Compact, click-to-open stage switcher. Lives on both the kanban card
// (compact) and the lead details page (same component — deeper
// management stays in the details view per the design brief, but the
// stage control itself is explicitly requested on the card too).
export function LeadStageControl({
  leadId,
  stage,
  contactName,
  size = "sm",
}: {
  leadId: string;
  stage: LeadStage;
  contactName: string;
  size?: "sm" | "md";
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const lostDialogRef = useRef<HTMLDialogElement>(null);
  const wonDialogRef = useRef<HTMLDialogElement>(null);

  function handleSelect(next: LeadStage) {
    setMenuOpen(false);
    if (next === stage) return;

    if (next === "LOST") {
      lostDialogRef.current?.showModal();
      return;
    }
    if (next === "WON") {
      wonDialogRef.current?.showModal();
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await changeLeadStage(leadId, next);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={isPending}
        className="flex items-center gap-1 rounded-full outline-none disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
      >
        <Badge tone={LEAD_STAGE_TONE[stage]}>
          {isPending ? "מעדכנת…" : LEAD_STAGE_LABELS[stage]}
        </Badge>
        <ChevronDown
          className={`h-3 w-3 text-zinc-400 ${size === "sm" ? "" : "h-3.5 w-3.5"}`}
        />
      </button>

      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="סגירה"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setMenuOpen(false)}
          />
          <div
            role="listbox"
            className="absolute end-0 z-50 mt-1.5 w-48 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg"
          >
            {LEAD_STAGES.map((s) => (
              <button
                key={s}
                type="button"
                role="option"
                aria-selected={s === stage}
                onClick={() => handleSelect(s)}
                className={`flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-zinc-50 ${
                  s === stage ? "font-semibold text-zinc-900" : "text-zinc-600"
                }`}
              >
                {LEAD_STAGE_LABELS[s]}
                {s === stage && <span className="text-rose-500">•</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {error && (
        <p className="absolute end-0 top-full z-50 mt-1 w-56 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700 shadow-md">
          {error}
        </p>
      )}

      <LostReasonDialog
        ref={lostDialogRef}
        leadId={leadId}
        onDone={() => lostDialogRef.current?.close()}
      />
      <WonConversionDialog
        ref={wonDialogRef}
        leadId={leadId}
        contactName={contactName}
        onDone={() => wonDialogRef.current?.close()}
      />
    </div>
  );
}
