"use client";

import { forwardRef, useRef, useState, useTransition } from "react";
import { MessageCirclePlus } from "lucide-react";
import { recordConversation } from "@/app/(app)/leads/actions";
import {
  LEAD_CONVERSATION_OUTCOMES,
  LEAD_CONVERSATION_OUTCOME_LABELS,
  LEAD_STAGE_LABELS,
  type LeadConversationOutcome,
  type LeadStage,
} from "@/lib/crm/constants";
import { nextEligibleFollowUpDay, zonedParts } from "@/lib/crm/timezone";

const inputClass =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-rose-400 focus:ring-2 focus:ring-rose-100";
const labelClass = "text-xs font-medium text-zinc-700";

// Outcomes that naturally lead to a follow-up call: the "create a
// follow-up" option starts ticked for them (visible, and Gal can untick
// it — nothing is ever created silently).
const FOLLOW_UP_BY_DEFAULT: LeadConversationOutcome[] = ["CALL_TOMORROW", "CALL_BACK_LATER"];

const DEFAULT_FOLLOW_UP_TITLE: Partial<Record<LeadConversationOutcome, string>> = {
  CALL_TOMORROW: "להתקשר אליה",
  CALL_BACK_LATER: "לחזור אליה",
  WANTS_TRIAL: "לקבוע אימון ניסיון",
  NO_ANSWER: "לנסות שוב להשיג אותה",
};

function nextEligibleDayKey(): string {
  return nextEligibleFollowUpDay(zonedParts(new Date()).dateKey);
}

type Props = {
  leadId: string;
  currentStage: LeadStage;
  /** Stage Gal picked from the stage menu (CONTACTED/INTERESTED), or
   *  null when opened from "עדכון שיחה" without a stage choice. */
  targetStage: LeadStage | null;
  onDone: () => void;
};

// Conversation update: outcome + free-text note, optional stage change
// and optional MANUAL follow-up — all saved together, in one
// transaction, by recordConversation (record_lead_conversation). Every
// update is appended to the lead's history; nothing is overwritten.
export const ConversationUpdateDialog = forwardRef<HTMLDialogElement, Props>(
  function ConversationUpdateDialog({ leadId, currentStage, targetStage, onDone }, ref) {
    const [outcome, setOutcome] = useState<LeadConversationOutcome | "">("");
    const [note, setNote] = useState("");
    const [stage, setStage] = useState<LeadStage>(targetStage ?? currentStage);
    const [trialConfirmed, setTrialConfirmed] = useState(false);
    const [createFollowUp, setCreateFollowUp] = useState(false);
    const [fuTitle, setFuTitle] = useState("");
    const [fuDate, setFuDate] = useState("");
    const [fuTime, setFuTime] = useState("10:00");
    const [error, setError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const stageOptions = Array.from(
      new Set<LeadStage>([targetStage ?? currentStage, currentStage, "CONTACTED", "INTERESTED"])
    );
    const isNoAnswer = outcome === "NO_ANSWER";

    function reset() {
      setOutcome("");
      setNote("");
      setStage(targetStage ?? currentStage);
      setTrialConfirmed(false);
      setCreateFollowUp(false);
      setFuTitle("");
      setFuDate("");
      setFuTime("10:00");
      setError(null);
    }

    function selectOutcome(next: LeadConversationOutcome) {
      setOutcome(next);
      setError(null);
      setTrialConfirmed(false);
      setCreateFollowUp(FOLLOW_UP_BY_DEFAULT.includes(next));
      setFuTitle(DEFAULT_FOLLOW_UP_TITLE[next] ?? "שיחת המשך");
      // "להתקשר מחר" prefills the next eligible business day (Sun-Thu);
      // "לחזור אליה בתאריך אחר" deliberately leaves the date empty so Gal
      // must choose one.
      setFuDate(next === "CALL_TOMORROW" ? nextEligibleDayKey() : "");
      setFuTime("10:00");
    }

    function handleSave() {
      if (!outcome) {
        setError("יש לבחור איך הסתיימה השיחה.");
        return;
      }
      if (outcome === "OTHER" && !note.trim()) {
        setError('כשבוחרים "אחר" יש לכתוב הערה.');
        return;
      }
      if (createFollowUp && (!fuDate || !fuTime)) {
        setError("יש לבחור תאריך ושעה למעקב.");
        return;
      }

      const requestedStage: LeadStage | null = isNoAnswer
        ? null
        : outcome === "WANTS_TRIAL" && trialConfirmed
          ? "TRIAL_BOOKED"
          : stage !== currentStage
            ? stage
            : null;

      startTransition(async () => {
        const result = await recordConversation({
          leadId,
          outcome,
          note: note || null,
          newStage: requestedStage,
          followUp: createFollowUp
            ? { title: fuTitle, date: fuDate, time: fuTime, notes: null }
            : null,
        });
        if (result.error) {
          setError(result.error);
          return;
        }
        reset();
        onDone();
      });
    }

    return (
      <dialog
        ref={ref}
        onClose={reset}
        className="w-full max-w-md rounded-2xl border border-zinc-200 p-0 text-right shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">עדכון שיחה</h2>
          <p className="mt-1 text-xs text-zinc-500">
            כל עדכון נשמר בהיסטוריה של הליד — שום הערה קודמת לא נמחקת.
          </p>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          <fieldset>
            <legend className={labelClass}>איך הסתיימה השיחה? *</legend>
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {LEAD_CONVERSATION_OUTCOMES.map((o) => (
                <label
                  key={o}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    outcome === o
                      ? "border-rose-400 bg-rose-50 text-rose-900"
                      : "border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="conversation_outcome"
                    value={o}
                    checked={outcome === o}
                    onChange={() => selectOutcome(o)}
                    className="accent-rose-600"
                  />
                  {LEAD_CONVERSATION_OUTCOME_LABELS[o]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1">
            <label htmlFor="conversation_note" className={labelClass}>
              {outcome === "OTHER" ? "הערה *" : "הערה (לא חובה)"}
            </label>
            <textarea
              id="conversation_note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={inputClass}
              placeholder="מה נאמר בשיחה…"
            />
          </div>

          {isNoAnswer ? (
            <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
              &quot;לא ענתה&quot; נשמר בהיסטוריה, והשלב נשאר &quot;{LEAD_STAGE_LABELS[currentStage]}&quot;
              — הליד לא יסומן כאילו נוצר קשר.
            </p>
          ) : outcome === "WANTS_TRIAL" ? (
            <label className="flex items-start gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={trialConfirmed}
                onChange={(e) => setTrialConfirmed(e.target.checked)}
                className="mt-0.5 accent-rose-600"
              />
              <span>
                האימון כבר נקבע בפועל — לעדכן את השלב ל&quot;{LEAD_STAGE_LABELS.TRIAL_BOOKED}&quot;
                <span className="block text-xs text-zinc-500">
                  אם עוד לא נקבע מועד — השאירי לא מסומן וצרי מעקב לקביעת האימון.
                </span>
              </span>
            </label>
          ) : null}

          {!isNoAnswer && !(outcome === "WANTS_TRIAL" && trialConfirmed) && (
            <div className="space-y-1">
              <label htmlFor="conversation_stage" className={labelClass}>
                שלב הליד אחרי השיחה
              </label>
              <select
                id="conversation_stage"
                value={stage}
                onChange={(e) => setStage(e.target.value as LeadStage)}
                className={inputClass}
              >
                {stageOptions.map((s) => (
                  <option key={s} value={s}>
                    {s === currentStage ? `${LEAD_STAGE_LABELS[s]} (ללא שינוי)` : LEAD_STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          )}

          {outcome && (
            <div className="rounded-xl border border-zinc-200 px-3 py-3">
              <label className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                <input
                  type="checkbox"
                  checked={createFollowUp}
                  onChange={(e) => setCreateFollowUp(e.target.checked)}
                  className="accent-rose-600"
                />
                ליצור מעקב
              </label>
              {createFollowUp && (
                <div className="mt-3 space-y-3">
                  <input
                    aria-label="מה צריך לעשות"
                    value={fuTitle}
                    onChange={(e) => setFuTitle(e.target.value)}
                    className={inputClass}
                    placeholder="מה צריך לעשות"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label htmlFor="conversation_fu_date" className={labelClass}>
                        תאריך *
                      </label>
                      <input
                        id="conversation_fu_date"
                        type="date"
                        dir="ltr"
                        required
                        value={fuDate}
                        onChange={(e) => setFuDate(e.target.value)}
                        className={`${inputClass} text-left`}
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="conversation_fu_time" className={labelClass}>
                        שעה *
                      </label>
                      <input
                        id="conversation_fu_time"
                        type="time"
                        dir="ltr"
                        required
                        value={fuTime}
                        onChange={(e) => setFuTime(e.target.value)}
                        className={`${inputClass} text-left`}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500">
                    המעקב יחליף מעקב פתוח קודם, אם יש. אם הוא עדיין לא יושלם, תישלח תזכורת אחת
                    ביום העסקים שאחרי מועד המעקב, ב-10:00.
                  </p>
                </div>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-4">
          <button
            type="button"
            onClick={() => (ref as React.RefObject<HTMLDialogElement>)?.current?.close()}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending || !outcome}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-60"
          >
            {isPending ? "שומרת…" : "שמירת עדכון"}
          </button>
        </div>
      </dialog>
    );
  }
);

/** "עדכון שיחה" button for the lead page (no stage pre-selected). */
export function ConversationUpdateButton({
  leadId,
  currentStage,
}: {
  leadId: string;
  currentStage: LeadStage;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700"
      >
        <MessageCirclePlus className="h-4 w-4" />
        עדכון שיחה
      </button>
      <ConversationUpdateDialog
        ref={dialogRef}
        leadId={leadId}
        currentStage={currentStage}
        targetStage={null}
        onDone={() => dialogRef.current?.close()}
      />
    </>
  );
}
