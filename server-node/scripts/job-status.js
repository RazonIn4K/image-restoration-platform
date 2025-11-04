#!/usr/bin/env node

/**
 * Job Status Tool
 * 
 * CLI tool for checking job status across main queue, DLQ, and Firestore
 * 
 * Usage:
 *   npm run jobs:status -- <jobId>           # Check specific job status
 *   npm run jobs:status -- queue-stats       # Show queue statistics
 */

import { assertRequiredSecrets } from '../src/config/secrets.js';
import { getJob, getQueueStats } from '../src/queues/restorationQueue.js';
import { getDLQStats, listDLQJobs } from '../src/queues/deadLetterQueue.js';
import { getClients } from '../src/context/clients.js';

// Validate secrets before starting
assertRequiredSecrets();

async function main() {
  const args = process.argv.slice(2);
  const jobId = args[0];

  if (!jobId || jobId === 'help' || jobId === '--help') {
    showHelp();
    process.exit(0);
  }

  try {
    if (jobId === 'queue-stats') {
      await showQueueStats();
    } else {
      await showJobStatus(jobId);
    }

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

async function showJobStatus(jobId) {
  console.log(`🔍 Checking status for job: ${jobId}\n`);

  // Check main queue
  const queueJob = await getJob(jobId);
  
  // Check Firestore
  const clients = getClients();
  let firestoreJob = null;
  if (clients.firestore) {
    try {
      const doc = await clients.firestore.collection('jobs').doc(jobId).get();
      firestoreJob = doc.exists ? doc.data() : null;
    } catch (error) {
      console.warn('⚠️  Could not check Firestore:', error.message);
    }
  }

  // Check DLQ
  const dlqJobs = await listDLQJobs(1000);
  const dlqJob = dlqJobs.find(job => job.originalJobId === jobId);

  // Display results
  console.log('📊 Job Status Summary:');
  console.log('─'.repeat(50));

  if (queueJob) {
    console.log(`Queue Status:     ${queueJob.opts.jobId ? 'Found' : 'Not Found'}`);
    console.log(`Queue State:      ${await queueJob.getState()}`);
    console.log(`Attempts:         ${queueJob.attemptsMade}/${queueJob.opts.attempts}`);
    console.log(`Created:          ${new Date(queueJob.timestamp).toLocaleString()}`);
    
    if (queueJob.processedOn) {
      console.log(`Processed:        ${new Date(queueJob.processedOn).toLocaleString()}`);
    }
    
    if (queueJob.failedReason) {
      console.log(`Failure Reason:   ${queueJob.failedReason}`);
    }
  } else {
    console.log('Queue Status:     Not Found');
  }

  console.log('');

  if (firestoreJob) {
    console.log(`Firestore Status: Found`);
    console.log(`Status:           ${firestoreJob.status}`);
    console.log(`Created:          ${firestoreJob.createdAt?.toDate?.()?.toLocaleString() || 'Unknown'}`);
    console.log(`Updated:          ${firestoreJob.updatedAt?.toDate?.()?.toLocaleString() || 'Unknown'}`);
    
    if (firestoreJob.timings) {
      console.log(`Timings:          ${JSON.stringify(firestoreJob.timings)}`);
    }
    
    if (firestoreJob.error) {
      console.log(`Error:            ${firestoreJob.error.message || firestoreJob.error}`);
    }
    
    if (firestoreJob.dlqJobId) {
      console.log(`DLQ Job ID:       ${firestoreJob.dlqJobId}`);
    }
    
    if (firestoreJob.replayedJobId) {
      console.log(`Replayed As:      ${firestoreJob.replayedJobId}`);
    }
  } else {
    console.log('Firestore Status: Not Found');
  }

  console.log('');

  if (dlqJob) {
    console.log(`DLQ Status:       Found`);
    console.log(`DLQ Job ID:       ${dlqJob.id}`);
    console.log(`Failed At:        ${dlqJob.failedAt}`);
    console.log(`Error:            ${dlqJob.error}`);
    console.log(`Attempts:         ${dlqJob.attempts}`);
  } else {
    console.log('DLQ Status:       Not Found');
  }

  // Provide recommendations
  console.log('\n💡 Recommendations:');
  
  if (dlqJob) {
    console.log(`   • Job is in DLQ - use: npm run jobs:replay -- replay ${dlqJob.id}`);
  } else if (queueJob && await queueJob.getState() === 'failed') {
    console.log('   • Job failed but not in DLQ yet - check if it will retry');
  } else if (queueJob && await queueJob.getState() === 'waiting') {
    console.log('   • Job is waiting to be processed');
  } else if (queueJob && await queueJob.getState() === 'active') {
    console.log('   • Job is currently being processed');
  } else if (firestoreJob?.status === 'succeeded') {
    console.log('   • Job completed successfully');
  } else {
    console.log('   • Job not found in any system - may have been cleaned up');
  }
}

async function showQueueStats() {
  console.log('📊 Queue Statistics:\n');

  // Main queue stats
  const queueStats = await getQueueStats();
  console.log('Main Restoration Queue:');
  console.log(`  Waiting:    ${queueStats.waiting}`);
  console.log(`  Active:     ${queueStats.active}`);
  console.log(`  Completed:  ${queueStats.completed}`);
  console.log(`  Failed:     ${queueStats.failed}`);
  console.log(`  Delayed:    ${queueStats.delayed}`);
  console.log(`  Total:      ${queueStats.total}`);

  if (queueStats.error) {
    console.log(`  Error:      ${queueStats.error}`);
  }

  console.log('');

  // DLQ stats
  const dlqStats = await getDLQStats();
  console.log('Dead Letter Queue:');
  console.log(`  Waiting:    ${dlqStats.waiting}`);
  console.log(`  Failed:     ${dlqStats.failed}`);
  console.log(`  Completed:  ${dlqStats.completed}`);
  console.log(`  Total:      ${dlqStats.total}`);

  if (dlqStats.error) {
    console.log(`  Error:      ${dlqStats.error}`);
  }

  console.log('');

  // Health assessment
  const totalActive = queueStats.active + queueStats.waiting;
  const totalFailed = queueStats.failed + dlqStats.total;
  
  console.log('🏥 Health Assessment:');
  
  if (totalFailed === 0) {
    console.log('  ✅ All systems healthy - no failed jobs');
  } else if (totalFailed < 10) {
    console.log('  ✅ Normal operation - minimal failures');
  } else if (totalFailed < 50) {
    console.log('  ⚠️  Elevated failures - monitor closely');
  } else {
    console.log('  🚨 High failure rate - investigate immediately');
  }

  if (totalActive > 100) {
    console.log('  ⚠️  High queue depth - consider scaling workers');
  }

  console.log(`\nLast updated: ${new Date().toLocaleString()}`);
}

function showHelp() {
  console.log('🔍 Job Status Tool\n');
  console.log('Usage:');
  console.log('  npm run jobs:status -- <jobId>        Check specific job status');
  console.log('  npm run jobs:status -- queue-stats    Show queue statistics');
  console.log('');
  console.log('Examples:');
  console.log('  npm run jobs:status -- job-abc123');
  console.log('  npm run jobs:status -- queue-stats');
  console.log('');
  console.log('With Doppler:');
  console.log('  doppler run -- npm run jobs:status -- <jobId>');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Run the CLI
main().catch(error => {
  console.error('💥 Unexpected error:', error);
  process.exit(1);
});