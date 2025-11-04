import { Queue, Worker } from 'bullmq';
import { getClients } from '../context/clients.js';
import { moveToDeadLetterQueue } from './deadLetterQueue.js';

/**
 * Restoration Queue Configuration
 * 
 * Main job queue for image restoration with DLQ integration
 */

const QUEUE_NAME = 'restoration';
const MAX_ATTEMPTS = 5;

let restorationQueue;

export function getRestorationQueue() {
  if (!restorationQueue) {
    const clients = getClients();
    
    restorationQueue = new Queue(QUEUE_NAME, {
      connection: clients.redis,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,  // Keep last 100 successful jobs
        removeOnFail: false,    // Don't auto-remove failed jobs (DLQ handles this)
      }
    });

    // Set up DLQ integration
    setupDLQIntegration(restorationQueue);
  }

  return restorationQueue;
}

/**
 * Set up dead letter queue integration
 */
function setupDLQIntegration(queue) {
  // Listen for failed jobs that have exhausted all retries
  queue.on('failed', async (job, error) => {
    if (job.attemptsMade >= MAX_ATTEMPTS) {
      try {
        console.log(`[queue] Job ${job.id} failed after ${job.attemptsMade} attempts, moving to DLQ`);
        await moveToDeadLetterQueue(job, error, job.attemptsMade);
        
        // Remove the job from the main queue after moving to DLQ
        await job.remove();
        
      } catch (dlqError) {
        console.error(`[queue] Failed to move job ${job.id} to DLQ:`, dlqError.message);
        // Job remains in failed state in main queue as fallback
      }
    }
  });

  // Log successful job completions
  queue.on('completed', (job) => {
    console.log(`[queue] Job ${job.id} completed successfully`);
  });

  // Log job progress
  queue.on('progress', (job, progress) => {
    console.log(`[queue] Job ${job.id} progress: ${progress}%`);
  });

  // Log when jobs are added
  queue.on('waiting', (job) => {
    console.log(`[queue] Job ${job.id} added to queue`);
  });
}

/**
 * Add a restoration job to the queue
 * @param {Object} jobData - Job data including userId, imageBuffer, etc.
 * @param {Object} options - Job options (priority, delay, etc.)
 * @returns {Promise<Object>} The created job
 */
export async function addRestorationJob(jobData, options = {}) {
  const queue = getRestorationQueue();
  
  // Ensure required fields are present
  if (!jobData.userId) {
    throw new Error('Job data must include userId');
  }

  // Add trace context if available
  const jobDataWithTrace = {
    ...jobData,
    enqueuedAt: new Date().toISOString(),
    ...options.traceContext && { traceContext: options.traceContext }
  };

  const job = await queue.add('restoration', jobDataWithTrace, {
    priority: options.priority || 0,
    delay: options.delay || 0,
    attempts: options.attempts || MAX_ATTEMPTS,
    jobId: options.jobId, // Allow custom job IDs
    ...options.jobOptions
  });

  console.log(`[queue] Added restoration job ${job.id} for user ${jobData.userId}`);
  return job;
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
  const queue = getRestorationQueue();

  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(), 
      queue.getCompleted(),
      queue.getFailed(),
      queue.getDelayed()
    ]);

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
      total: waiting.length + active.length + completed.length + failed.length + delayed.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('[queue] Failed to get stats:', error.message);
    return {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      total: 0,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Get a specific job by ID
 */
export async function getJob(jobId) {
  const queue = getRestorationQueue();
  return await queue.getJob(jobId);
}

/**
 * Pause the queue (stops processing new jobs)
 */
export async function pauseQueue() {
  const queue = getRestorationQueue();
  await queue.pause();
  console.log('[queue] Queue paused');
}

/**
 * Resume the queue
 */
export async function resumeQueue() {
  const queue = getRestorationQueue();
  await queue.resume();
  console.log('[queue] Queue resumed');
}

/**
 * Clean up old jobs
 */
export async function cleanupQueue(olderThan = 24 * 60 * 60 * 1000) {
  const queue = getRestorationQueue();
  
  const cleaned = await queue.clean(olderThan, 100, 'completed');
  console.log(`[queue] Cleaned up ${cleaned.length} old completed jobs`);
  
  return cleaned.length;
}

export { QUEUE_NAME, MAX_ATTEMPTS };