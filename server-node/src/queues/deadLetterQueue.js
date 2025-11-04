import { Queue } from 'bullmq';
import { getClients } from '../context/clients.js';

/**
 * Dead Letter Queue - Manages failed jobs that have exhausted all retry attempts
 * 
 * Features:
 * - Automatic job migration from main queue after MAX_ATTEMPTS
 * - Firestore persistence for audit and analysis
 * - Replay tooling support
 * - Monitoring and metrics
 */

const DLQ_NAME = 'restoration-dlq';
const MAX_DLQ_JOBS = 10000; // Prevent unbounded growth

let deadLetterQueue;

export function getDeadLetterQueue() {
  if (!deadLetterQueue) {
    const clients = getClients();
    
    deadLetterQueue = new Queue(DLQ_NAME, {
      connection: clients.redis,
      defaultJobOptions: {
        removeOnComplete: 100,   // Keep some completed replays for monitoring
        removeOnFail: 100,       // Keep some failed replays for debugging
        attempts: 1,             // DLQ jobs get one attempt when replayed
        backoff: 'off'           // No backoff for DLQ replays
      }
    });

    // Clean up old DLQ jobs to prevent unbounded growth
    setInterval(async () => {
      try {
        await cleanupOldDLQJobs();
      } catch (error) {
        console.error('[dlq] Cleanup failed:', error.message);
      }
    }, 24 * 60 * 60 * 1000); // Daily cleanup
  }

  return deadLetterQueue;
}

/**
 * Move a failed job to the dead letter queue
 * @param {Object} originalJob - The failed job from the main queue
 * @param {Object} error - The error that caused the failure
 * @param {number} attempts - Number of attempts made
 */
export async function moveToDeadLetterQueue(originalJob, error, attempts) {
  const dlq = getDeadLetterQueue();
  const clients = getClients();

  try {
    // Create DLQ job with original data plus failure metadata
    const dlqJobData = {
      originalJobId: originalJob.id,
      originalData: originalJob.data,
      failureInfo: {
        error: {
          message: error.message,
          code: error.code || 'UNKNOWN_ERROR',
          stack: error.stack
        },
        attempts,
        failedAt: new Date().toISOString(),
        lastAttemptAt: originalJob.processedOn ? new Date(originalJob.processedOn).toISOString() : null
      },
      metadata: {
        userId: originalJob.data.userId,
        jobType: 'restoration',
        priority: originalJob.opts?.priority || 0
      }
    };

    // Add to DLQ
    const dlqJob = await dlq.add('failed-restoration', dlqJobData, {
      jobId: `dlq-${originalJob.id}`, // Predictable DLQ job ID
      priority: originalJob.opts?.priority || 0
    });

    // Update Firestore with DLQ status
    if (clients.firestore && originalJob.data.userId) {
      await clients.firestore.collection('jobs').doc(originalJob.id).set({
        status: 'failed',
        dlqJobId: dlqJob.id,
        dlqMovedAt: new Date(),
        error: {
          message: error.message,
          code: error.code || 'UNKNOWN_ERROR'
        },
        attempts,
        updatedAt: new Date()
      }, { merge: true });
    }

    console.log(`[dlq] Moved job ${originalJob.id} to dead letter queue as ${dlqJob.id}`);
    return dlqJob;

  } catch (dlqError) {
    console.error(`[dlq] Failed to move job ${originalJob.id} to DLQ:`, dlqError.message);
    throw dlqError;
  }
}

/**
 * Replay a job from the dead letter queue
 * @param {string} dlqJobId - DLQ job ID to replay
 * @param {Object} options - Replay options
 * @returns {Promise<Object>} Replay result
 */
export async function replayJob(dlqJobId, options = {}) {
  const dlq = getDeadLetterQueue();
  const clients = getClients();

  try {
    // Get the DLQ job
    const dlqJob = await dlq.getJob(dlqJobId);
    if (!dlqJob) {
      throw new Error(`DLQ job ${dlqJobId} not found`);
    }

    const { originalJobId, originalData, failureInfo, metadata } = dlqJob.data;

    // Check if this job was already replayed successfully
    if (clients.firestore) {
      const jobDoc = await clients.firestore.collection('jobs').doc(originalJobId).get();
      if (jobDoc.exists && jobDoc.data().status === 'succeeded') {
        throw new Error(`Job ${originalJobId} already completed successfully`);
      }
    }

    // Check credit refund status to avoid double-refunding
    const creditRefunded = await checkCreditRefundStatus(originalJobId, metadata.userId);

    // Create new job in main restoration queue
    const { Queue: RestorationQueue } = await import('./restorationQueue.js');
    const mainQueue = new RestorationQueue('restoration', {
      connection: clients.redis
    });

    // Add replay metadata to job data
    const replayJobData = {
      ...originalData,
      replay: {
        originalJobId,
        dlqJobId,
        replayedAt: new Date().toISOString(),
        previousAttempts: failureInfo.attempts,
        replayReason: options.reason || 'Manual replay'
      }
    };

    const newJob = await mainQueue.add('restoration', replayJobData, {
      priority: (options.priority !== undefined) ? options.priority : metadata.priority,
      attempts: options.attempts || 5,
      ...options.jobOptions
    });

    // Update Firestore
    if (clients.firestore) {
      await clients.firestore.collection('jobs').doc(originalJobId).set({
        status: 'queued',
        replayedJobId: newJob.id,
        replayedAt: new Date(),
        replayCount: (await getReplayCount(originalJobId)) + 1,
        updatedAt: new Date()
      }, { merge: true });

      // Log replay event
      await clients.firestore.collection('job_replays').add({
        originalJobId,
        dlqJobId,
        newJobId: newJob.id,
        userId: metadata.userId,
        reason: options.reason || 'Manual replay',
        creditRefunded,
        replayedAt: new Date(),
        replayedBy: options.replayedBy || 'system'
      });
    }

    // Remove from DLQ (job has been replayed)
    await dlqJob.remove();

    console.log(`[dlq] Replayed job ${originalJobId} as ${newJob.id}, removed from DLQ`);

    return {
      success: true,
      originalJobId,
      newJobId: newJob.id,
      dlqJobId,
      creditRefunded
    };

  } catch (error) {
    console.error(`[dlq] Failed to replay job ${dlqJobId}:`, error.message);
    throw error;
  }
}

/**
 * Get DLQ statistics for monitoring
 */
export async function getDLQStats() {
  const dlq = getDeadLetterQueue();

  try {
    const [waiting, failed, completed] = await Promise.all([
      dlq.getWaiting(),
      dlq.getFailed(),
      dlq.getCompleted()
    ]);

    return {
      waiting: waiting.length,
      failed: failed.length,
      completed: completed.length,
      total: waiting.length + failed.length + completed.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('[dlq] Failed to get stats:', error.message);
    return {
      waiting: 0,
      failed: 0,
      completed: 0,
      total: 0,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * List jobs in the dead letter queue
 */
export async function listDLQJobs(limit = 50, offset = 0) {
  const dlq = getDeadLetterQueue();

  try {
    const jobs = await dlq.getJobs(['waiting', 'failed'], offset, offset + limit - 1);
    
    return jobs.map(job => ({
      id: job.id,
      originalJobId: job.data.originalJobId,
      userId: job.data.metadata?.userId,
      failedAt: job.data.failureInfo?.failedAt,
      error: job.data.failureInfo?.error?.message,
      attempts: job.data.failureInfo?.attempts,
      priority: job.opts?.priority || 0
    }));
  } catch (error) {
    console.error('[dlq] Failed to list jobs:', error.message);
    return [];
  }
}

// Helper functions

async function cleanupOldDLQJobs() {
  const dlq = getDeadLetterQueue();
  
  // Remove jobs older than 30 days
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  
  const oldJobs = await dlq.getJobs(['waiting', 'failed'], 0, -1);
  const jobsToRemove = oldJobs.filter(job => 
    job.timestamp < thirtyDaysAgo
  );

  for (const job of jobsToRemove) {
    await job.remove();
  }

  if (jobsToRemove.length > 0) {
    console.log(`[dlq] Cleaned up ${jobsToRemove.length} old DLQ jobs`);
  }
}

async function checkCreditRefundStatus(jobId, userId) {
  const clients = getClients();
  
  if (!clients.firestore) {
    return false;
  }

  try {
    const refundQuery = await clients.firestore
      .collection('credit_ledger')
      .where('jobId', '==', jobId)
      .where('type', '==', 'refund')
      .limit(1)
      .get();

    return !refundQuery.empty;
  } catch (error) {
    console.warn(`[dlq] Failed to check refund status for job ${jobId}:`, error.message);
    return false;
  }
}

async function getReplayCount(jobId) {
  const clients = getClients();
  
  if (!clients.firestore) {
    return 0;
  }

  try {
    const replayQuery = await clients.firestore
      .collection('job_replays')
      .where('originalJobId', '==', jobId)
      .get();

    return replayQuery.size;
  } catch (error) {
    console.warn(`[dlq] Failed to get replay count for job ${jobId}:`, error.message);
    return 0;
  }
}

export { DLQ_NAME, MAX_DLQ_JOBS };