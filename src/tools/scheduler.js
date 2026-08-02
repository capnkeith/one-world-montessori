'use strict';

const assert = require('node:assert');
const { z } = require('zod');
const { Tool } = require('../core/Tool');
const { Scheduler } = require('../core/Scheduler');

/**
 * Generic calendar-based background job scheduling, exposed as one MCP
 * tool: add/list/get/cancel/run jobs, plus recording feedback against a
 * specific run (e.g. a recipient's response to an emailed task). What a
 * job actually *does* lives entirely in `handlers` (type -> async fn),
 * injected from outside — this tool only owns scheduling/persistence/
 * lifecycle, never a specific job's business logic.
 *
 * `nodeId` identifies this instance for the claim/lease model (see
 * Scheduler.js) - defaults to a random id per process if not given,
 * which is fine for a single-node setup but a real multi-node
 * deployment should pass each node's real instanceId.
 */
function createSchedulerTool({ jobStore, handlers = {}, nodeId = `node-${Math.random().toString(36).slice(2)}` }) {
  const scheduler = new Scheduler({ store: jobStore });

  return new Tool({
    name: 'scheduler',
    version: '2.2.0',
    description:
      'Generic calendar-based background job scheduling with a claim/lease model for safe multi-node execution: add/list/get/cancel/run jobs, reclaim stale leases, record feedback on a run.',
    mcpInputSchema: {
      action: z
        .enum([
          'addJob',
          'listJobs',
          'getJob',
          'updateJob',
          'cancelJob',
          'runJob',
          'runDueJobs',
          'reclaimStaleLeases',
          'recordFeedback',
        ])
        .optional(),
      type: z.string().optional(),
      label: z.string().optional(),
      schedule: z.any().optional(),
      params: z.any().optional(),
      attachments: z
        .array(z.object({ filename: z.string(), mimeType: z.string(), contentBase64: z.string() }))
        .optional(),
      retryPolicy: z.enum(['idempotent', 'at-most-once']).optional(),
      id: z.string().optional(),
      runIndex: z.number().optional(),
      feedback: z.any().optional(),
    },

    run: async (params) => {
      const action = params?.action ?? 'listJobs';

      switch (action) {
        case 'addJob':
          return scheduler.addJob({
            type: params.type,
            label: params.label,
            schedule: params.schedule,
            params: params.params,
            attachments: params.attachments,
            retryPolicy: params.retryPolicy,
          });

        case 'listJobs':
          return { jobs: scheduler.listJobs() };

        case 'getJob': {
          if (!params.id) throw new Error('getJob requires id');
          const job = scheduler.getJob(params.id);
          if (!job) throw new Error(`No job with id ${params.id}`);
          return { job };
        }

        case 'updateJob':
          // Deliberately never forwards `attachments` (or `type`) — a
          // job's email attachments are fixed at addJob time; see
          // Scheduler.updateJob's doc comment for why.
          if (!params.id) throw new Error('updateJob requires id');
          return scheduler.updateJob(params.id, {
            label: params.label,
            schedule: params.schedule,
            params: params.params,
            retryPolicy: params.retryPolicy,
          });

        case 'cancelJob':
          if (!params.id) throw new Error('cancelJob requires id');
          return scheduler.cancelJob(params.id);

        case 'runJob':
          if (!params.id) throw new Error('runJob requires id');
          return scheduler.runJob(params.id, { handlers, nodeId });

        case 'runDueJobs':
          return scheduler.runDueJobs({ handlers, nodeId });

        case 'reclaimStaleLeases':
          return scheduler.reclaimStaleLeases();

        case 'recordFeedback':
          if (!params.id) throw new Error('recordFeedback requires id');
          if (params.runIndex === undefined) throw new Error('recordFeedback requires runIndex');
          return scheduler.recordFeedback({ id: params.id, runIndex: params.runIndex, feedback: params.feedback });

        default:
          throw new Error(`Unknown scheduler action: ${action}`);
      }
    },

    // Fully self-contained: its own throwaway store and a fake job type,
    // never touches the real job file or a real handler.
    internalTest: async ({ call }) => {
      let fakeJobs = [];
      const fakeStore = {
        load: () => fakeJobs,
        save: (jobs) => {
          fakeJobs = jobs;
        },
        mutate: (id, updaterFn) => {
          const job = fakeJobs.find((j) => j.id === id);
          if (!job) return null;
          return updaterFn(job) ? job : null;
        },
      };
      let handlerCalls = 0;
      const fakeHandlers = {
        'test-echo': async (params) => {
          handlerCalls += 1;
          return { echoed: params };
        },
      };
      const fakeTool = createSchedulerTool({ jobStore: fakeStore, handlers: fakeHandlers, nodeId: 'test-node' });

      const added = await fakeTool.invoke({
        action: 'addJob',
        type: 'test-echo',
        label: 'Test job',
        schedule: { type: 'monthly', dayOfMonth: 2 },
        params: { foo: 'bar' },
      });
      assert.ok(added.result.id);
      assert.strictEqual(added.result.status, 'scheduled');
      assert.strictEqual(added.result.retryPolicy, 'idempotent');

      const listed = await fakeTool.invoke({ action: 'listJobs' });
      assert.strictEqual(listed.result.jobs.length, 1);

      const fetched = await fakeTool.invoke({ action: 'getJob', id: added.result.id });
      assert.strictEqual(fetched.result.job.id, added.result.id);

      const updated = await fakeTool.invoke({ action: 'updateJob', id: added.result.id, params: { foo: 'baz' } });
      assert.deepStrictEqual(updated.result.params, { foo: 'baz' });

      const ran = await fakeTool.invoke({ action: 'runJob', id: added.result.id });
      assert.strictEqual(handlerCalls, 1);
      assert.strictEqual(ran.result.history.length, 1);
      assert.strictEqual(ran.result.history[0].status, 'success');
      assert.deepStrictEqual(ran.result.history[0].detail, { echoed: { foo: 'baz' } });
      assert.strictEqual(ran.result.claimedBy, null, 'the claim must be released after completion');

      const fedBack = await fakeTool.invoke({
        action: 'recordFeedback',
        id: added.result.id,
        runIndex: 0,
        feedback: { approved: true },
      });
      assert.deepStrictEqual(fedBack.result.history[0].feedback, { approved: true });

      const reclaimResult = await fakeTool.invoke({ action: 'reclaimStaleLeases' });
      assert.strictEqual(reclaimResult.result.releasedCount, 0, 'nothing is claimed right now, so nothing to reclaim');

      const cancelled = await fakeTool.invoke({ action: 'cancelJob', id: added.result.id });
      assert.strictEqual(cancelled.result.status, 'cancelled');

      return { passed: true };
    },

    realWorldTest: async (testConfig, { call }) => {
      const { result } = await call({ action: 'listJobs' });
      assert.ok(Array.isArray(result.jobs));
      return { passed: true, checkedAgainst: testConfig.label ?? 'unnamed-fixture' };
    },
  });
}

module.exports = { createSchedulerTool };
