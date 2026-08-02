'use strict';

const crypto = require('crypto');

const DEFAULT_LEASE_MS = 10 * 60_000; // 10 minutes

/**
 * Calendar-based job scheduling core, with a claim/lease model so
 * multiple nodes can safely share one job store without two of them
 * ever running the same job at once. Pure logic plus an injectable
 * `store` ({ load(): Job[], save(jobs), mutate(id, updaterFn) }) so this
 * is fully unit testable with no real clock or filesystem. What a job
 * *does* is deliberately not known here - each job carries a `type`,
 * and the actual work for that type is supplied externally as a
 * `handlers` map (type -> async fn) at call time, so adding a new kind
 * of job never requires changing this file.
 *
 * Job shape: { id, type, label, schedule, params, attachments, retryPolicy,
 * status, createdAt, nextRunAt, lastRunAt, claimedBy, claimedAt,
 * leaseExpiresAt, history: [{ranAt, status, detail|error, feedback?}] }
 *
 * `status`: 'scheduled' (waiting, or due and unclaimed) | 'claimed' (a
 * node is running it right now) | 'stuck' (a claim's lease expired
 * without completing, and retryPolicy said not to auto-retry - needs a
 * human) | 'cancelled' | 'completed' (one-off jobs only, once run).
 *
 * `retryPolicy`: 'idempotent' (default) - safe to hand to another node
 * automatically if the claiming node disappears mid-run. 'at-most-once'
 * - the job has a real external side effect (e.g. sending an email)
 * that isn't safe to blindly retry, since we can't know whether it
 * already happened; a lease expiring on one of these produces a
 * 'stuck' job instead of a silent automatic retry.
 *
 * `attachments` (files pre-staged for a job type that emails something,
 * e.g. send-monthly-invoice-email) is fixed once at addJob time and is
 * deliberately not one of the fields updateJob can touch — see updateJob's
 * comment. This is the DLP guardrail: a job can only ever email what it
 * was created with (plus whatever a rendering tool builds fresh at run
 * time, e.g. the invoice PDF), never something added or fetched later.
 */
class Scheduler {
  constructor({ store }) {
    this.store = store;
  }

  addJob({ type, label, schedule, params = {}, attachments = [], retryPolicy = 'idempotent', now = new Date() }) {
    if (!type) throw new Error('addJob requires a type');
    if (!schedule) throw new Error('addJob requires a schedule');
    const nextRunAt = computeNextRun(schedule, now);

    const job = {
      id: crypto.randomUUID(),
      type,
      label: label ?? type,
      schedule,
      params,
      attachments,
      retryPolicy,
      status: 'scheduled',
      createdAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      history: [],
    };
    const jobs = this.store.load();
    jobs.push(job);
    this.store.save(jobs);
    return job;
  }

  listJobs() {
    return this.store.load();
  }

  getJob(id) {
    return this.store.load().find((j) => j.id === id) ?? null;
  }

  /**
   * Merges a patch (label/schedule/params/retryPolicy) into an existing job;
   * recomputes nextRunAt if the schedule changed. Deliberately never
   * touches `type` or `attachments`, even if present on `patch` — those are
   * fixed at addJob time. This is what lets an automated reply-handling
   * agent (Claude, via the `claude` tool's update_job_params) freely
   * correct recipients/cc/subject/body without ever being able to redirect
   * a job into attaching something it wasn't created with, or turning it
   * into a different kind of job entirely.
   */
  updateJob(id, patch, { now = new Date() } = {}) {
    const jobs = this.store.load();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`No job with id ${id}`);
    if (job.status === 'cancelled') throw new Error(`Job ${id} is cancelled`);

    if (patch.label !== undefined) job.label = patch.label;
    if (patch.params !== undefined) job.params = patch.params;
    if (patch.retryPolicy !== undefined) job.retryPolicy = patch.retryPolicy;
    if (patch.schedule !== undefined) {
      job.schedule = patch.schedule;
      job.nextRunAt = computeNextRun(patch.schedule, now).toISOString();
    }
    this.store.save(jobs);
    return job;
  }

  cancelJob(id) {
    const jobs = this.store.load();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`No job with id ${id}`);
    job.status = 'cancelled';
    job.nextRunAt = null;
    this.store.save(jobs);
    return job;
  }

  /** Attaches feedback (e.g. a recipient's response) to a specific run in a job's history. */
  recordFeedback({ id, runIndex, feedback }) {
    const jobs = this.store.load();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`No job with id ${id}`);
    const entry = job.history[runIndex];
    if (!entry) throw new Error(`Job ${id} has no history entry at index ${runIndex}`);
    entry.feedback = feedback;
    this.store.save(jobs);
    return job;
  }

  /**
   * Atomically claims the next due, unclaimed job for `nodeId` - tries
   * each due candidate in turn so a lost race on one doesn't stop
   * another node from picking up a different due job. Returns null if
   * nothing is claimable right now.
   */
  claimNextDueJob({ nodeId, now = new Date(), leaseMs = DEFAULT_LEASE_MS }) {
    const candidates = this.store
      .load()
      .filter((j) => j.status === 'scheduled' && j.nextRunAt && new Date(j.nextRunAt) <= now);

    for (const candidate of candidates) {
      const claimed = this.store.mutate(candidate.id, (job) => {
        if (job.status !== 'scheduled' || !job.nextRunAt || new Date(job.nextRunAt) > now) return false;
        job.status = 'claimed';
        job.claimedBy = nodeId;
        job.claimedAt = now.toISOString();
        job.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
        return true;
      });
      if (claimed) return claimed;
    }
    return null;
  }

  /** Claims a specific job regardless of due-ness (manual force-run) - fails if someone else already holds it. */
  claimJob(id, { nodeId, now = new Date(), leaseMs = DEFAULT_LEASE_MS }) {
    const job = this.store.mutate(id, (j) => {
      if (j.status === 'cancelled') throw new Error(`Job ${id} is cancelled`);
      if (j.status !== 'scheduled') return false;
      j.status = 'claimed';
      j.claimedBy = nodeId;
      j.claimedAt = now.toISOString();
      j.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      return true;
    });
    if (!job) {
      const existing = this.getJob(id);
      if (!existing) throw new Error(`No job with id ${id}`);
      throw new Error(`Job ${id} is already claimed by ${existing.claimedBy ?? 'another node'}`);
    }
    return job;
  }

  /** Records the outcome of a run and releases the claim - only the node that holds it can complete it. */
  completeJob({ id, nodeId, status, detail, error, now = new Date() }) {
    const job = this.store.mutate(id, (j) => {
      if (j.claimedBy !== nodeId) return false;
      const entry = { ranAt: now.toISOString(), status };
      if (status === 'success') entry.detail = detail ?? null;
      else entry.error = error;
      j.history.push(entry);
      j.lastRunAt = entry.ranAt;
      j.claimedBy = null;
      j.claimedAt = null;
      j.leaseExpiresAt = null;

      if (j.schedule.type === 'once') {
        j.status = 'completed';
        j.nextRunAt = null;
      } else {
        j.status = 'scheduled';
        j.nextRunAt = computeNextRun(j.schedule, now).toISOString();
      }
      return true;
    });
    if (!job) throw new Error(`Job ${id} is not claimed by ${nodeId} (lease may have expired)`);
    return job;
  }

  /**
   * Finds claims whose lease expired without completing (the claiming
   * node crashed/hung). Idempotent jobs go back to 'scheduled' so any
   * node can pick them up again immediately; at-most-once jobs become
   * 'stuck' instead, since we can't safely assume the side effect never
   * happened.
   */
  reclaimStaleLeases({ now = new Date() } = {}) {
    const stale = this.store
      .load()
      .filter((j) => j.status === 'claimed' && j.leaseExpiresAt && new Date(j.leaseExpiresAt) <= now);

    const released = [];
    const stuck = [];
    for (const job of stale) {
      const result = this.store.mutate(job.id, (j) => {
        if (j.status !== 'claimed' || !j.leaseExpiresAt || new Date(j.leaseExpiresAt) > now) return false;
        if (j.retryPolicy === 'at-most-once') {
          j.status = 'stuck';
          return true;
        }
        j.status = 'scheduled';
        j.claimedBy = null;
        j.claimedAt = null;
        j.leaseExpiresAt = null;
        return true;
      });
      if (result) {
        if (result.status === 'stuck') stuck.push(result);
        else released.push(result);
      }
    }
    return { releasedCount: released.length, stuckCount: stuck.length, released, stuck };
  }

  /** Forces one job to run right now, regardless of its schedule. */
  async runJob(id, { handlers, nodeId = 'manual', now = new Date() }) {
    const job = this.claimJob(id, { nodeId, now });
    const handler = handlers[job.type];
    if (!handler) {
      return this.completeJob({ id, nodeId, status: 'failed', error: `No handler registered for job type "${job.type}"`, now });
    }
    try {
      const detail = (await handler(job.params, job)) ?? null;
      return this.completeJob({ id, nodeId, status: 'success', detail, now });
    } catch (err) {
      return this.completeJob({ id, nodeId, status: 'failed', error: err.message, now });
    }
  }

  /** Claims and runs every due job in turn, for `nodeId`. */
  async runDueJobs({ handlers, nodeId = 'local', now = new Date() }) {
    const ran = [];
    for (;;) {
      const job = this.claimNextDueJob({ nodeId, now });
      if (!job) break;

      const handler = handlers[job.type];
      let completed;
      if (!handler) {
        completed = this.completeJob({
          id: job.id,
          nodeId,
          status: 'failed',
          error: `No handler registered for job type "${job.type}"`,
          now,
        });
      } else {
        try {
          const detail = (await handler(job.params, job)) ?? null;
          completed = this.completeJob({ id: job.id, nodeId, status: 'success', detail, now });
        } catch (err) {
          completed = this.completeJob({ id: job.id, nodeId, status: 'failed', error: err.message, now });
        }
      }
      ran.push(completed);
    }
    return { ranCount: ran.length, jobs: ran };
  }
}

function computeNextRun(schedule, from) {
  if (schedule.type === 'once') {
    return new Date(schedule.at);
  }
  if (schedule.type === 'monthly') {
    return computeNextMonthlyRun(from, schedule.dayOfMonth, schedule.hour ?? 9, schedule.minute ?? 0);
  }
  throw new Error(`Unknown schedule type "${schedule.type}"`);
}

/** Next occurrence of `dayOfMonth`/`hour`/`minute` strictly after `from`. */
function computeNextMonthlyRun(from, dayOfMonth, hour, minute) {
  let candidate = new Date(from.getFullYear(), from.getMonth(), dayOfMonth, hour, minute, 0, 0);
  if (candidate <= from) {
    candidate = new Date(from.getFullYear(), from.getMonth() + 1, dayOfMonth, hour, minute, 0, 0);
  }
  return candidate;
}

module.exports = { Scheduler, computeNextRun, computeNextMonthlyRun };
