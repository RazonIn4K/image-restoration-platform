#!/usr/bin/env node

/**
 * Dead Letter Queue Replay Tool
 * 
 * CLI tool for managing and replaying failed jobs from the dead letter queue.
 * 
 * Usage:
 *   npm run jobs:replay -- list                    # List DLQ jobs
 *   npm run jobs:replay -- stats                   # Show DLQ statistics  
 *   npm run jobs:replay -- replay <dlqJobId>       # Replay specific job
 *   npm run jobs:replay -- replay-all              # Replay all DLQ jobs
 *   npm run jobs:replay -- replay-user <userId>    # Replay jobs for specific user
 *   npm run jobs:replay -- cleanup                 # Clean up old DLQ jobs
 */

import { assertRequiredSecrets } from '../src/config/secrets.js';
import { getDeadLetterQueue, replayJob, getDLQStats, listDLQJobs } from '../src/queues/deadLetterQueue.js';
import { getClients } from '../src/context/clients.js';

// Validate secrets before starting
assertRequiredSecrets();

const COMMANDS = {
  list: 'List jobs in the dead letter queue',
  stats: 'Show DLQ statistics and health',
  replay: 'Replay a specific job by DLQ job ID',
  'replay-all': 'Replay all jobs in the DLQ (use with caution)',
  'replay-user': 'Replay all jobs for a specific user ID',
  cleanup: 'Remove old jobs from the DLQ'
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const param = args[1];

  if (!command || command === 'help' || command === '--help') {
    showHelp();
    process.exit(0);
  }

  if (!COMMANDS[command]) {
    console.error(`❌ Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }

  try {
    console.log(`🔄 Executing: ${command}${param ? ` ${param}` : ''}`);
    
    switch (command) {
      case 'list':
        await listCommand(param);
        break;
      case 'stats':
        await statsCommand();
        break;
      case 'replay':
        await replayCommand(param);
        break;
      case 'replay-all':
        await replayAllCommand();
        break;
      case 'replay-user':
        await replayUserCommand(param);
        break;
      case 'cleanup':
        await cleanupCommand();
        break;
      default:
        throw new Error(`Command ${command} not implemented`);
    }

    console.log('✅ Command completed successfully');
    process.exit(0);

  } catch (error) {
    console.error('❌ Command failed:', error.message);
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

async function listCommand(limitStr) {
  const limit = parseInt(limitStr) || 50;
  console.log(`📋 Listing up to ${limit} DLQ jobs...\n`);

  const jobs = await listDLQJobs(limit);
  
  if (jobs.length === 0) {
    console.log('🎉 No jobs in the dead letter queue!');
    return;
  }

  console.log(`Found ${jobs.length} jobs in DLQ:\n`);
  
  // Table header
  console.log('DLQ Job ID'.padEnd(20) + 'Original ID'.padEnd(15) + 'User ID'.padEnd(15) + 'Failed At'.padEnd(20) + 'Error');
  console.log('-'.repeat(100));

  // Table rows
  for (const job of jobs) {
    const dlqId = job.id.substring(0, 18) + '..';
    const originalId = job.originalJobId.substring(0, 13) + '..';
    const userId = job.userId ? job.userId.substring(0, 13) + '..' : 'unknown';
    const failedAt = job.failedAt ? new Date(job.failedAt).toLocaleDateString() : 'unknown';
    const error = job.error ? job.error.substring(0, 30) + '...' : 'unknown';
    
    console.log(
      dlqId.padEnd(20) + 
      originalId.padEnd(15) + 
      userId.padEnd(15) + 
      failedAt.padEnd(20) + 
      error
    );
  }

  console.log(`\n💡 Use 'npm run jobs:replay -- replay <dlqJobId>' to replay a specific job`);
}

async function statsCommand() {
  console.log('📊 DLQ Statistics:\n');

  const stats = await getDLQStats();
  
  if (stats.error) {
    console.log(`❌ Error getting stats: ${stats.error}`);
    return;
  }

  console.log(`Waiting jobs:    ${stats.waiting}`);
  console.log(`Failed replays:  ${stats.failed}`);
  console.log(`Completed:       ${stats.completed}`);
  console.log(`Total DLQ jobs:  ${stats.total}`);
  console.log(`Last updated:    ${new Date(stats.timestamp).toLocaleString()}`);

  // Health assessment
  if (stats.total === 0) {
    console.log('\n🎉 DLQ is empty - all jobs processing successfully!');
  } else if (stats.waiting > 100) {
    console.log('\n⚠️  High number of failed jobs - investigate common failure patterns');
  } else if (stats.failed > 10) {
    console.log('\n⚠️  Some replay attempts are failing - check job data integrity');
  } else {
    console.log('\n✅ DLQ levels are normal');
  }
}

async function replayCommand(dlqJobId) {
  if (!dlqJobId) {
    throw new Error('DLQ job ID is required. Usage: npm run jobs:replay -- replay <dlqJobId>');
  }

  console.log(`🔄 Replaying job: ${dlqJobId}`);

  const result = await replayJob(dlqJobId, {
    reason: 'Manual replay via CLI',
    replayedBy: 'cli-tool'
  });

  console.log(`✅ Job replayed successfully:`);
  console.log(`   Original Job ID: ${result.originalJobId}`);
  console.log(`   New Job ID:      ${result.newJobId}`);
  console.log(`   Credit Refunded: ${result.creditRefunded ? 'Yes' : 'No'}`);
  console.log(`\n💡 Monitor the new job with: npm run jobs:status -- ${result.newJobId}`);
}

async function replayAllCommand() {
  console.log('⚠️  Replaying ALL jobs in DLQ...');
  
  // Safety confirmation
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise(resolve => {
    rl.question('Are you sure you want to replay ALL failed jobs? (yes/no): ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'yes') {
    console.log('❌ Cancelled by user');
    return;
  }

  const jobs = await listDLQJobs(1000); // Get up to 1000 jobs
  console.log(`🔄 Found ${jobs.length} jobs to replay...\n`);

  let successCount = 0;
  let failureCount = 0;

  for (const job of jobs) {
    try {
      console.log(`Replaying ${job.id}...`);
      await replayJob(job.id, {
        reason: 'Bulk replay via CLI',
        replayedBy: 'cli-tool'
      });
      successCount++;
    } catch (error) {
      console.error(`Failed to replay ${job.id}: ${error.message}`);
      failureCount++;
    }
  }

  console.log(`\n📊 Replay Summary:`);
  console.log(`   Successful: ${successCount}`);
  console.log(`   Failed:     ${failureCount}`);
  console.log(`   Total:      ${jobs.length}`);
}

async function replayUserCommand(userId) {
  if (!userId) {
    throw new Error('User ID is required. Usage: npm run jobs:replay -- replay-user <userId>');
  }

  console.log(`🔄 Replaying jobs for user: ${userId}`);

  const allJobs = await listDLQJobs(1000);
  const userJobs = allJobs.filter(job => job.userId === userId);

  if (userJobs.length === 0) {
    console.log(`🎉 No failed jobs found for user ${userId}`);
    return;
  }

  console.log(`Found ${userJobs.length} jobs for user ${userId}`);

  let successCount = 0;
  let failureCount = 0;

  for (const job of userJobs) {
    try {
      console.log(`Replaying ${job.id}...`);
      await replayJob(job.id, {
        reason: `User-specific replay for ${userId}`,
        replayedBy: 'cli-tool'
      });
      successCount++;
    } catch (error) {
      console.error(`Failed to replay ${job.id}: ${error.message}`);
      failureCount++;
    }
  }

  console.log(`\n📊 User Replay Summary:`);
  console.log(`   User ID:    ${userId}`);
  console.log(`   Successful: ${successCount}`);
  console.log(`   Failed:     ${failureCount}`);
  console.log(`   Total:      ${userJobs.length}`);
}

async function cleanupCommand() {
  console.log('🧹 Cleaning up old DLQ jobs...');

  const dlq = getDeadLetterQueue();
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  
  const oldJobs = await dlq.getJobs(['waiting', 'failed'], 0, -1);
  const jobsToRemove = oldJobs.filter(job => job.timestamp < thirtyDaysAgo);

  if (jobsToRemove.length === 0) {
    console.log('✅ No old jobs to clean up');
    return;
  }

  console.log(`Found ${jobsToRemove.length} jobs older than 30 days`);

  for (const job of jobsToRemove) {
    await job.remove();
  }

  console.log(`✅ Cleaned up ${jobsToRemove.length} old DLQ jobs`);
}

function showHelp() {
  console.log('🔧 Dead Letter Queue Replay Tool\n');
  console.log('Available commands:\n');
  
  for (const [cmd, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(15)} ${desc}`);
  }
  
  console.log('\nExamples:');
  console.log('  npm run jobs:replay -- list');
  console.log('  npm run jobs:replay -- stats');
  console.log('  npm run jobs:replay -- replay dlq-abc123');
  console.log('  npm run jobs:replay -- replay-user user-456');
  console.log('\nEnvironment:');
  console.log('  Requires Doppler secrets to be configured');
  console.log('  Use: doppler run -- npm run jobs:replay -- <command>');
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