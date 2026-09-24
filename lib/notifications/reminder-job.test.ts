import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processFollowUpReminders,
  type ClaimedReminder,
  type ReminderContext,
  type ReminderRepo,
} from "./reminder-job.ts";
import type { EmailMessage, EmailProvider, EmailSendResult } from "./email-provider.ts";
import type { LeadStage } from "../crm/constants.ts";

// In-memory ReminderRepo mirroring SQL claim_due_follow_up_reminders():
// only PENDING tasks of unresolved leads, remind_at <= now, oldest first,
// bounded; FAILED retried after backoff; stale SENDING reclaimed; all
// bounded by maxAttempts. claimDue mutates synchronously (no await
// between select and update), which models FOR UPDATE SKIP LOCKED for
// concurrent Promise.all runs in a single-threaded event loop.

type Delivery = {
  id: string;
  taskId: string;
  status: "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";
  attemptCount: number;
  lastAttemptedAtMs: number | null;
  remindAtMs: number;
  lastError: string | null;
};

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 30 * 60_000;
const STALE_MS = 15 * 60_000;

function makeWorld(clock: { now: Date }) {
  const deliveries = new Map<string, Delivery>();
  const tasks = new Map<string, ReminderContext>();

  const repo: ReminderRepo = {
    async claimDue(limit) {
      const now = clock.now.getTime();
      const candidates = [...deliveries.values()]
        .filter((d) => {
          const t = tasks.get(d.taskId);
          if (!t || t.status !== "PENDING") return false;
          if (t.lead && (t.lead.stage === "WON" || t.lead.stage === "LOST")) return false;
          if (d.remindAtMs > now || d.attemptCount >= MAX_ATTEMPTS) return false;
          if (d.status === "PENDING") return true;
          if (d.status === "FAILED") return d.lastAttemptedAtMs === null || d.lastAttemptedAtMs + BACKOFF_MS <= now;
          if (d.status === "SENDING") return d.lastAttemptedAtMs !== null && d.lastAttemptedAtMs + STALE_MS <= now;
          return false;
        })
        .sort((a, b) => a.remindAtMs - b.remindAtMs)
        .slice(0, limit);
      return candidates.map((d) => {
        d.status = "SENDING";
        d.attemptCount += 1;
        d.lastAttemptedAtMs = now;
        return { deliveryId: d.id, taskId: d.taskId, attemptCount: d.attemptCount };
      });
    },
    async loadContexts(taskIds) {
      const m = new Map<string, ReminderContext>();
      for (const id of taskIds) {
        const t = tasks.get(id);
        if (t) m.set(id, structuredClone(t));
      }
      return m;
    },
    async markSent(claim, _sentAt, _id, note) {
      finish(claim, (d) => {
        d.status = "SENT";
        d.lastError = note;
      });
    },
    async markFailed(claim, error) {
      finish(claim, (d) => {
        d.status = "FAILED";
        d.lastError = error;
      });
    },
    async markSkipped(claim) {
      finish(claim, (d) => {
        d.status = "SKIPPED";
      });
    },
  };

  function finish(claim: ClaimedReminder, apply: (d: Delivery) => void) {
    const d = deliveries.get(claim.deliveryId);
    if (d && d.status === "SENDING" && d.attemptCount === claim.attemptCount) apply(d);
  }

  function addLeadTask(
    id: string,
    opts: { source?: "AUTOMATIC" | "MANUAL"; remindAt: string; stage?: LeadStage }
  ) {
    tasks.set(id, {
      taskId: id,
      source: opts.source ?? "MANUAL",
      status: "PENDING",
      title: "להתקשר אליה",
      notes: null,
      dueAtIso: opts.remindAt,
      lead: {
        id: `lead-${id}`,
        stage: opts.stage ?? "NEW",
        createdAtIso: "2026-09-20T09:00:00.000Z",
        fullName: "דנה כהן",
        phone: "0501234567",
        interestedServices: ["GROUP_TRAINING"],
        primaryChannel: "META_AD",
        latestConversation: null,
      },
      customer: null,
    });
    deliveries.set(`d-${id}`, {
      id: `d-${id}`,
      taskId: id,
      status: "PENDING",
      attemptCount: 0,
      lastAttemptedAtMs: null,
      remindAtMs: new Date(opts.remindAt).getTime(),
      lastError: null,
    });
  }

  return { repo, deliveries, tasks, addLeadTask };
}

// Fake Resend: honours Idempotency-Key like the real API (same key +
// same payload -> original id, nothing re-delivered; same key +
// different payload -> 409 invalid_idempotent_request).
function makeProvider(opts: { failTimes?: number } = {}) {
  let failuresLeft = opts.failTimes ?? 0;
  const delivered: EmailMessage[] = [];
  const byKey = new Map<string, { id: string; payload: string }>();
  let calls = 0;
  const provider: EmailProvider = {
    async send(message): Promise<EmailSendResult> {
      calls += 1;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return { ok: false, error: "Resend API error (HTTP 503): unavailable" };
      }
      const payload = JSON.stringify([message.subject, message.html, message.text]);
      if (message.idempotencyKey) {
        const prior = byKey.get(message.idempotencyKey);
        if (prior && prior.payload === payload) return { ok: true, providerMessageId: prior.id };
        if (prior) return { ok: false, error: "Resend API error (HTTP 409)", alreadyAccepted: true };
      }
      const id = `msg-${delivered.length + 1}`;
      delivered.push(message);
      if (message.idempotencyKey) byKey.set(message.idempotencyKey, { id, payload });
      return { ok: true, providerMessageId: id };
    },
  };
  return { provider, delivered, calls: () => calls };
}

// Wednesday 2026-09-23 10:30 Israel (IDT, UTC+3) = 07:30Z.
const WEDNESDAY_1030 = new Date("2026-09-23T07:30:00.000Z");
const WEDNESDAY_1000_ISO = "2026-09-23T07:00:00.000Z";

function run(world: ReturnType<typeof makeWorld>, provider: EmailProvider, clock: { now: Date }) {
  return processFollowUpReminders({
    repo: world.repo,
    provider,
    recipient: "gal@example.test",
    appBaseUrl: "https://crm.example.test",
    now: () => clock.now,
  });
}

test("exactly one new-lead reminder: sent once, never again on later runs or later days", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  world.addLeadTask("auto1", { source: "AUTOMATIC", remindAt: WEDNESDAY_1000_ISO });

  const first = await run(world, provider, clock);
  assert.equal(first.sent, 1);
  assert.equal(delivered[0].subject, "תזכורת לליד חדש — דנה כהן");

  await run(world, provider, clock);
  clock.now = new Date("2026-09-24T07:30:00.000Z"); // Thursday, lead still open
  await run(world, provider, clock);
  clock.now = new Date("2026-09-27T07:30:00.000Z"); // Sunday
  await run(world, provider, clock);

  assert.equal(delivered.length, 1, "no daily escalation loop — one email, ever");
  assert.equal(world.deliveries.get("d-auto1")?.status, "SENT");
});

test("exactly one reminder per unresolved manual follow-up, with the manual subject", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  world.addLeadTask("m1", { source: "MANUAL", remindAt: WEDNESDAY_1000_ISO });

  await run(world, provider, clock);
  await run(world, provider, clock);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].subject, "מעקב שטרם הושלם — דנה כהן");
});

test("a reminder is not sent before its remind_at", async () => {
  const clock = { now: new Date("2026-09-23T06:59:00.000Z") }; // Wed 09:59 Israel
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  world.addLeadTask("m1", { remindAt: WEDNESDAY_1000_ISO });
  await run(world, provider, clock);
  assert.equal(delivered.length, 0);
});

test("no reminder after the task was completed or cancelled", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  world.addLeadTask("m1", { remindAt: WEDNESDAY_1000_ISO });
  world.addLeadTask("m2", { remindAt: WEDNESDAY_1000_ISO });
  world.tasks.get("m1")!.status = "COMPLETED";
  world.tasks.get("m2")!.status = "CANCELLED";
  await run(world, provider, clock);
  assert.equal(delivered.length, 0);
});

test("a WON/LOST lead never gets a reminder", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  world.addLeadTask("won", { remindAt: WEDNESDAY_1000_ISO, stage: "WON" });
  world.addLeadTask("lost", { remindAt: WEDNESDAY_1000_ISO, stage: "LOST" });
  await run(world, provider, clock);
  assert.equal(delivered.length, 0);
});

test("a task closed between claim and send is skipped, not sent (stale-read guard)", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  world.addLeadTask("m1", { remindAt: WEDNESDAY_1000_ISO });
  const realLoad = world.repo.loadContexts.bind(world.repo);
  world.repo.loadContexts = async (ids) => {
    world.tasks.get("m1")!.status = "COMPLETED"; // Gal completes it mid-run
    return realLoad(ids);
  };
  await run(world, provider, clock);
  assert.equal(delivered.length, 0);
  assert.equal(world.deliveries.get("d-m1")?.status, "SKIPPED");
});

test("Friday and Saturday (Israel) never send anything", async () => {
  const world = makeWorld({ now: WEDNESDAY_1030 });
  const { provider, delivered } = makeProvider();
  world.addLeadTask("m1", { remindAt: WEDNESDAY_1000_ISO });
  for (const iso of ["2026-09-25T07:30:00.000Z", "2026-09-26T07:30:00.000Z"]) {
    const clock = { now: new Date(iso) };
    const result = await run(world, provider, clock);
    assert.equal(result.skipped, "weekend_quiet_day");
  }
  assert.equal(delivered.length, 0);
  assert.equal(world.deliveries.get("d-m1")?.status, "PENDING");
});

test("concurrent cron runs never send the same reminder twice", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  for (let i = 0; i < 12; i++) world.addLeadTask(`t${i}`, { remindAt: WEDNESDAY_1000_ISO });

  await Promise.all([run(world, provider, clock), run(world, provider, clock), run(world, provider, clock)]);

  assert.equal(delivered.length, 12);
  const keys = delivered.map((m) => m.idempotencyKey);
  assert.equal(new Set(keys).size, 12, "every delivery sent exactly once");
});

test("a failed send is retried only after the backoff, and stops after 5 attempts (retry exhaustion)", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered, calls } = makeProvider({ failTimes: 100 });
  world.addLeadTask("m1", { remindAt: WEDNESDAY_1000_ISO });

  await run(world, provider, clock);
  assert.equal(world.deliveries.get("d-m1")?.status, "FAILED");
  await run(world, provider, clock); // within backoff: not retried
  assert.equal(calls(), 1);

  for (let i = 1; i <= 10; i++) {
    clock.now = new Date(WEDNESDAY_1030.getTime() + i * 31 * 60_000);
    await run(world, provider, clock);
  }
  assert.equal(calls(), 5, "bounded: exactly MAX_ATTEMPTS provider calls");
  assert.equal(world.deliveries.get("d-m1")?.attemptCount, 5);
  assert.equal(world.deliveries.get("d-m1")?.status, "FAILED");
  assert.equal(delivered.length, 0);
});

test("a temporary failure then success sends exactly one email", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider({ failTimes: 1 });
  world.addLeadTask("m1", { remindAt: WEDNESDAY_1000_ISO });
  await run(world, provider, clock);
  clock.now = new Date(WEDNESDAY_1030.getTime() + 31 * 60_000);
  await run(world, provider, clock);
  await run(world, provider, clock);
  assert.equal(delivered.length, 1);
  assert.equal(world.deliveries.get("d-m1")?.status, "SENT");
});

test("stale SENDING recovery: a crashed attempt is reclaimed, and the idempotency key prevents a duplicate email", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  world.addLeadTask("m1", { remindAt: WEDNESDAY_1000_ISO });

  // Attempt 1: the provider accepts the email, then the process dies
  // before the result is recorded — row left in SENDING.
  const [claim] = await world.repo.claimDue(5);
  const ctx = (await world.repo.loadContexts([claim.taskId])).get(claim.taskId)!;
  const { buildReminderEmail } = await import("./reminder-job.ts");
  const email = buildReminderEmail(ctx, "https://crm.example.test");
  await provider.send({ to: "gal@example.test", ...email, idempotencyKey: `gal-crm-follow-up-reminder-${claim.deliveryId}` });
  assert.equal(world.deliveries.get("d-m1")?.status, "SENDING");

  // Before the stale window: not reclaimed.
  clock.now = new Date(WEDNESDAY_1030.getTime() + 10 * 60_000);
  await run(world, provider, clock);
  assert.equal(world.deliveries.get("d-m1")?.status, "SENDING");

  // After the stale window: reclaimed, resent with the SAME key.
  clock.now = new Date(WEDNESDAY_1030.getTime() + 16 * 60_000);
  await run(world, provider, clock);
  assert.equal(world.deliveries.get("d-m1")?.status, "SENT");
  assert.equal(world.deliveries.get("d-m1")?.attemptCount, 2);
  assert.equal(delivered.length, 1, "provider de-duplicated the retry — Gal got one email");
});

test("provider 'idempotency key already used' is recorded as SENT, never retried under a new key", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const provider: EmailProvider = {
    async send() {
      return { ok: false, error: "Resend API error (HTTP 409)", alreadyAccepted: true };
    },
  };
  world.addLeadTask("m1", { remindAt: WEDNESDAY_1000_ISO });
  await run(world, provider, clock);
  assert.equal(world.deliveries.get("d-m1")?.status, "SENT");
});

test("oldest due reminders are claimed first and a large backlog is fully drained (no starvation)", async () => {
  const clock = { now: WEDNESDAY_1030 };
  const world = makeWorld(clock);
  const { provider, delivered } = makeProvider();
  for (let i = 0; i < 30; i++) {
    world.addLeadTask(`t${String(i).padStart(2, "0")}`, {
      remindAt: new Date(new Date(WEDNESDAY_1000_ISO).getTime() - (30 - i) * 60_000).toISOString(),
    });
  }
  // Closed tasks' rows (the old starvation source) never block due ones.
  for (let i = 0; i < 300; i++) {
    world.addLeadTask(`closed${i}`, { remindAt: "2026-09-01T07:00:00.000Z" });
    world.tasks.get(`closed${i}`)!.status = "CANCELLED";
  }
  await run(world, provider, clock);
  assert.equal(delivered.length, 30);
});
