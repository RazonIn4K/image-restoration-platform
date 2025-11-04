import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const DEFAULT_QUEUE_NAME = process.env.JOBS_QUEUE_NAME ?? 'image-restoration-jobs';
const MAX_ATTEMPTS = Number(process.env.JOBS_MAX_ATTEMPTS ?? 5);
const BASE_DELAY_MS = Number(process.env.JOBS_BACKOFF_BASE_MS ?? 1000);
const JITTER_RATIO = Number(process.env.JOBS_BACKOFF_JITTER ?? 0.3);
const REMOVE_ON_COMPLETE = Number(process.env.JOBS_REMOVE_ON_COMPLETE ?? 100);
const REMOVE_ON_FAIL = Number(process.env.JOBS_REMOVE_ON_FAIL ?? 500);

let queueInstance;
let connectionInstance;

function getRedisConnection() {
  if (connectionInstance) {
    return connectionInstance;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is not configured. BullMQ queue cannot be initialized.');
  }

  connectionInstance = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  connectionInstance.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('[queue] Redis connection error', { error: error?.message });
  });

  return connectionInstance;
}

function calculateBackoff(attemptsMade) {
  const exponent = Math.max(0, attemptsMade - 1);
  const baseDelay = BASE_DELAY_MS * Math.pow(2, exponent);
  const jitter = baseDelay * JITTER_RATIO;
  const min = baseDelay - jitter;
  const max = baseDelay + jitter;
  const delay = Math.random() * (max - min) + min;
  return Math.round(Math.max(delay, 0));
}

export function getJobQueue() {
  if (queueInstance) {
    return queueInstance;
  }

  const connection = getRedisConnection();

  queueInstance = new Queue(DEFAULT_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'jittered-exponential' },
      removeOnComplete: REMOVE_ON_COMPLETE,
      removeOnFail: REMOVE_ON_FAIL,
    },
    settings: {
      backoffStrategies: {
        'jittered-exponential': (attemptsMade) => calculateBackoff(attemptsMade),
      },
    },
  });

  queueInstance.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('[queue] Queue error', { error: error?.message });
  });

  return queueInstance;
}

export async function closeJobQueue() {
  const tasks = [];
  if (queueInstance) {
    tasks.push(queueInstance.close());
    queueInstance = undefined;
  }
  if (connectionInstance) {
    tasks.push(connectionInstance.quit());
    connectionInstance = undefined;
  }
  await Promise.all(tasks);
}

export const __testables = {
  calculateBackoff,
};
