import { Worker, QueueScheduler } from 'bullmq';
import IORedis from 'ioredis';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';

import { getClients } from '../../context/clients.js';
import { getServices } from '../../context/services.js';

const QUEUE_NAME = process.env.JOBS_QUEUE_NAME ?? 'image-restoration-jobs';
const CONCURRENCY = Number(process.env.JOBS_WORKER_CONCURRENCY ?? 2);
const STALLED_INTERVAL_MS = Number(process.env.JOBS_STALLED_CHECK_MS ?? 10000);

const clients = getClients();
const services = getServices(clients);

let schedulerInstance;
let workerInstance;
let redisConnection;

function getConnection() {
  if (redisConnection) {
    return redisConnection;
  }
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is not configured. BullMQ worker cannot start.');
  }
  redisConnection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redisConnection.on('error', (error) => {
    clients.logger?.error('[worker] Redis connection error', { error: error?.message });
  });

  return redisConnection;
}

function createSpanContextFromTraceparent(traceparent) {
  if (!traceparent) {
    return context.active();
  }

  const parts = traceparent.split('-');
  if (parts.length < 4) {
    return context.active();
  }

  const [, traceId, spanId] = parts;
  if (!traceId || !spanId) {
    return context.active();
  }

  return trace.setSpanContext(context.active(), {
    traceFlags: 1,
    traceId,
    spanId,
    isRemote: true,
  });
}

function getQueueScheduler() {
  if (schedulerInstance) {
    return schedulerInstance;
  }

  schedulerInstance = new QueueScheduler(QUEUE_NAME, {
    connection: getConnection(),
    stalledInterval: STALLED_INTERVAL_MS,
  });

  schedulerInstance.on('error', (error) => {
    clients.logger?.error('[worker] Queue scheduler error', { error: error?.message });
  });

  return schedulerInstance;
}

async function processJob(job) {
  const tracer = trace.getTracer('restoration-worker');
  const traceparent = job.data?.traceparent;
  const tracestate = job.data?.tracestate;

  const parentContext = createSpanContextFromTraceparent(traceparent);

  return context.with(parentContext, async () => {
    const span = tracer.startSpan('worker.process', {
      attributes: {
        'job.id': job.id,
        'job.name': job.name,
        'job.queue': QUEUE_NAME,
        'job.attempts_made': job.attemptsMade,
        'job.user_id': job.data?.userId ?? 'anonymous',
      },
    });

    const start = Date.now();
    try {
      clients.logger?.info('[worker] Processing job', {
        jobId: job.id,
        userId: job.data?.userId,
        attempts: job.attemptsMade,
      });

      if (!job.data?.imageBuffer) {
        throw new Error('Job payload missing imageBuffer');
      }

      const imageBuffer = Buffer.from(job.data.imageBuffer, 'base64');
      const userPrompt = job.data.userPrompt ?? null;
      const userContext = {
        userId: job.data.userId,
        jobId: job.data.jobId,
        traceparent,
        tracestate,
      };

      await clients.firestore.collection('restorations').doc(job.data.jobId).set({
        status: 'running',
        startedAt: new Date(),
        userId: job.data.userId,
        attemptsMade: job.attemptsMade,
      }, { merge: true });

      const restorationResult = await services.restorator.restore({
        imageBuffer,
        userPrompt,
        userContext,
        options: { preprocessingMetadata: job.data.preprocessing ?? {} },
      });

      if (!restorationResult.success) {
        throw new Error(restorationResult.error?.message ?? 'Restoration failed');
      }

      await clients.firestore.collection('restorations').doc(job.data.jobId).set({
        status: 'succeeded',
        userId: job.data.userId,
        timings: restorationResult.timings,
        enhancedPrompt: restorationResult.enhancedPrompt,
        degradationAnalysis: restorationResult.degradationAnalysis,
        providerMetadata: restorationResult.metadata,
        updatedAt: new Date(),
      }, { merge: true });

      const duration = Date.now() - start;
      span.setAttributes({
        'job.status': 'succeeded',
        'job.duration_ms': duration,
      });
      span.setStatus({ code: SpanStatusCode.OK });

      clients.logger?.info('[worker] Job completed', {
        jobId: job.id,
        duration,
      });

      return {
        ...restorationResult,
        jobId: job.data.jobId,
      };
    } catch (error) {
      const duration = Date.now() - start;
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });

      clients.logger?.error('[worker] Job failed', {
        jobId: job.id,
        error: error?.message,
        stack: error?.stack,
        duration,
      });

      await clients.firestore.collection('restorations').doc(job.data.jobId).set({
        status: 'failed',
        error: {
          message: error?.message,
          stack: error?.stack,
        },
        attemptsMade: job.attemptsMade,
        updatedAt: new Date(),
      }, { merge: true });

      const creditsToRefund = Number(job.data?.creditsSpent ?? 0);
      if (creditsToRefund > 0) {
        try {
          await services.credits.refund({
            userId: job.data.userId,
            jobId: job.data.jobId,
            amount: creditsToRefund,
            reason: 'Restoration job failed',
          });
        } catch (refundError) {
          clients.logger?.error('[worker] Failed to refund credits after job failure', {
            jobId: job.id,
            refundError: refundError?.message,
          });
        }
      }

      throw error;
    } finally {
      span.end();
    }
  });
}

export function startRestorationWorker() {
  if (workerInstance) {
    return workerInstance;
  }

  getQueueScheduler();

  workerInstance = new Worker(
    QUEUE_NAME,
    async (job) => processJob(job),
    {
      connection: getConnection(),
      concurrency: CONCURRENCY,
      autorun: true,
    }
  );

  workerInstance.on('completed', (job) => {
    clients.logger?.info('[worker] Job completed event', {
      jobId: job.id,
      returnvalue: job.returnvalue,
    });
  });

  workerInstance.on('failed', (job, error) => {
    clients.logger?.error('[worker] Job failed event', {
      jobId: job?.id,
      attempts: job?.attemptsMade,
      error: error?.message,
    });
  });

  workerInstance.on('error', (error) => {
    clients.logger?.error('[worker] Worker error', { error: error?.message });
  });

  return workerInstance;
}

export async function stopRestorationWorker() {
  const tasks = [];
  if (workerInstance) {
    tasks.push(workerInstance.close());
    workerInstance = undefined;
  }
  if (schedulerInstance) {
    tasks.push(schedulerInstance.close());
    schedulerInstance = undefined;
  }
  if (redisConnection) {
    tasks.push(redisConnection.quit());
    redisConnection = undefined;
  }
  await Promise.all(tasks);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRestorationWorker();

  const shutdown = async () => {
    try {
      await stopRestorationWorker();
      process.exit(0);
    } catch (error) {
      clients.logger?.error('[worker] Failed to stop gracefully', { error: error?.message });
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
