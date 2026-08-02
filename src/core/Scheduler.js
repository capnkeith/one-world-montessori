'use strict';

const crypto = require('crypto');

/**
 * Calendar-based job scheduling core. Pure logic plus an injectable
 * `store` ({ load(): Job[], save(jobs) }) so this is fully unit testable
 * with no real clock or filesystem. What a job *does* is deliberately not
 * known here - each job carries a `type`, and the actual work for that
 * type is supplied externally as a `handlers` map (type -> async fn) at
 * call time, so adding a new kind of job never requires changing this
 * file.
 *
 * Job shape: { id, type, label, schedule, params, status, createdAt,
 * nextRunAt, lastRunAt, history: [{ranAt, status, detail|error, feedback?}] }
 * `status` is 'scheduled' | 'cancelled' | 'completed' (one-off jobs only,
 * once they've run).
 */
class Scheduler {
  constructor({ store }) {
    this.store = store;
  }

  addJob({ type, label, schedule, params = {}, now = new Date() }) {
    if (!type) throw new Error('addJob requires a type');
    if (!schedule) throw new Error('addJob requires a schedule');
    const nextRunAt = computeNextRun(schedule, now);

    const job = {
      id: crypto.randomUUID(),
      type,
      label: label ?? type,
      schedule,
      params,
      status: 'scheduled',
      createdAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
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

  /** Forces one job to run right now, regardless of its schedule. */
  async runJob(id, { handlers, now = new Date() }) {
    const jobs = this.store.load();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`No job with id ${id}`);
    if (job.status === 'cancelled') throw new Error(`Job ${id} is cancelled`);

    const handler = handlers[job.type];
    if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);

    const entry = { ranAt: now.toISOString() };
    try {
      entry.detail = (await handler(job.params, job)) ?? null;
      entry.status = 'success';
    } catch (err) {
      entry.status = 'failed';
      entry.error = err.message;
    }
    job.history.push(entry);
    job.lastRunAt = entry.ranAt;

    if (job.schedule.type === 'once') {
      job.status = 'completed';
      job.nextRunAt = null;
    } else {
      job.nextRunAt = computeNextRun(job.schedule, now).toISOString();
    }
    this.store.save(jobs);
    return job;
  }

  /** Runs every scheduled job whose nextRunAt is due as of `now`. */
  async runDueJobs({ handlers, now = new Date() }) {
    const due = this.store
      .load()
      .filter((j) => j.status === 'scheduled' && j.nextRunAt && new Date(j.nextRunAt) <= now);

    const ran = [];
    for (const job of due) {
      ran.push(await this.runJob(job.id, { handlers, now }));
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
