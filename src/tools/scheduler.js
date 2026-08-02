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
 */
function createSchedulerTool({ jobStore, handlers = {} }) {
  const scheduler = new Scheduler({ store: jobStore });

  return new Tool({
    name: 'scheduler',
    version: '1.0.0',
    description: 'Generic calendar-based background job scheduling: add/list/get/cancel/run jobs, record feedback on a run.',
    mcpInputSchema: {
      action: z.enum(['addJob', 'listJobs', 'getJob', 'cancelJob', 'runJob', 'runDueJobs', 'recordFeedback']).optional(),
      type: z.string().optional(),
      label: z.string().optional(),
      schedule: z.any().optional(),
      params: z.any().optional(),
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
          });

        case 'listJobs':
          return { jobs: scheduler.listJobs() };

        case 'getJob': {
          if (!params.id) throw new Error('getJob requires id');
          const job = scheduler.getJob(params.id);
          if (!job) throw new Error(`No job with id ${params.id}`);
          return { job };
        }

        case 'cancelJob':
          if (!params.id) throw new Error('cancelJob requires id');
          return scheduler.cancelJob(params.id);

        case 'runJob':
          if (!params.id) throw new Error('runJob requires id');
          return scheduler.runJob(params.id, { handlers });

        case 'runDueJobs':
          return scheduler.runDueJobs({ handlers });

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
      };
      let handlerCalls = 0;
      const fakeHandlers = {
        'test-echo': async (params) => {
          handlerCalls += 1;
          return { echoed: params };
        },
      };
      const fakeTool = createSchedulerTool({ jobStore: fakeStore, handlers: fakeHandlers });

      const added = await fakeTool.invoke({
        action: 'addJob',
        type: 'test-echo',
        label: 'Test job',
        schedule: { type: 'monthly', dayOfMonth: 2 },
        params: { foo: 'bar' },
      });
      assert.ok(added.result.id);
      assert.strictEqual(added.result.status, 'scheduled');

      const listed = await fakeTool.invoke({ action: 'listJobs' });
      assert.strictEqual(listed.result.jobs.length, 1);

      const fetched = await fakeTool.invoke({ action: 'getJob', id: added.result.id });
      assert.strictEqual(fetched.result.job.id, added.result.id);

      const ran = await fakeTool.invoke({ action: 'runJob', id: added.result.id });
      assert.strictEqual(handlerCalls, 1);
      assert.strictEqual(ran.result.history.length, 1);
      assert.strictEqual(ran.result.history[0].status, 'success');
      assert.deepStrictEqual(ran.result.history[0].detail, { echoed: { foo: 'bar' } });

      const fedBack = await fakeTool.invoke({
        action: 'recordFeedback',
        id: added.result.id,
        runIndex: 0,
        feedback: { approved: true },
      });
      assert.deepStrictEqual(fedBack.result.history[0].feedback, { approved: true });

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
