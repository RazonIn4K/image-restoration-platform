# Implementation Guide (Index)

- Slides summary: `answer.pptx` (overview)  
- Full walkthrough: `image-restoration-platform.md` (detailed build plan)

This repository implements that plan. Track deltas from upstream docs here as we iterate.

## Doppler Secrets Management

All backend processes must run through Doppler so that secrets are never read from disk. Install the Doppler CLI and authenticate:

```bash
doppler login
doppler setup --project ai-restoration-similar --config dev
```

Run every Node command using the Doppler wrapper scripts defined in `server-node/package.json`:

```bash
# Development server
npm run dev:doppler

# Production-like start
npm run start:doppler

# Secret validation utility
npm run validate:secrets:doppler
```

### Required Secrets

The Express backend validates the presence of these secrets on startup:

- `GEMINI_API_KEY` - Google AI API key for Gemini 2.5 Flash Image
- `FIRESTORE_CREDS` - **Base64-encoded** Firebase service account JSON credentials
- `REDIS_URL` - Redis connection URL (e.g., redis://localhost:6379)
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook endpoint secret
- `NEXT_PUBLIC_API_URL` - Public API URL for CORS configuration
- `LOG_LEVEL` - Logging level (info, debug, error)

**Note:** `FIRESTORE_CREDS` must be base64-encoded. To encode your service account JSON:
```bash
cat service-account.json | base64
```

Running without the Doppler environment will terminate the process and print the missing keys. In CI, provide a Doppler service token via the `DOPPLER_TOKEN` environment variable and execute the same scripts.

### Environment Validation Script

`npm run validate:secrets` executes `server-node/scripts/validate-secrets.js`, which asserts the required secrets exist and recommends using `doppler run --` when they are missing. The Express entrypoint (`src/server.js`) invokes the same check during startup.

## File Upload Validation & Preprocessing

Image uploads are accepted only when they meet the following requirements:

- **Field name**: `image`
- **Maximum size**: 10 MB (requests above the limit return `413 Content Too Large` + `Retry-After` header)
- **Allowed formats**: JPEG, PNG, WebP (validated via file magic using `file-type`)
- **Allowed extensions**: `.jpg`, `.jpeg`, `.png`, `.webp`
- **Protection**: Compound extensions (for example `photo.jpg.php`) and unsupported media types return RFC 7807 problem responses

The middleware lives in `src/middleware/uploadValidation.js` and is wired into `POST /v1/jobs` ahead of downstream processing.

After validation, `src/middleware/imagePreprocess.js` performs normalization via **Sharp**:

- Auto-orients using `rotate()` to respect EXIF orientation
- Resizes the longest side down to ≤ 2048 px while preserving aspect ratio
- Encodes the image as JPEG at quality 85 with 4:4:4 chroma sampling
- Strips all EXIF metadata and attaches only an sRGB ICC profile
- Stores both original and processed metadata on `req.file` for downstream services

### Content Moderation

The `moderateImage` middleware invokes the `ModerationService` (Google Vision SafeSearch) before any restoration work begins:

- Requests are rejected with HTTP 422 `application/problem+json` responses whenever SafeSearch reports LIKELY/VERY_LIKELY adult, racy, or violent content
- Moderation audits are persisted to Firestore (`moderation_logs`) with available user/job context
- Moderation failures now default to **fail closed**—service outages reject content instead of passing it through

## Job Queue & Worker

BullMQ powers asynchronous restoration jobs. Configuration lives in `src/queues/jobQueue.js` and provides:

- Redis connection sourced from `REDIS_URL`
- Jittered exponential backoff (±30%) with a configurable base delay (`JOBS_BACKOFF_BASE_MS`)
- Default job attempts (`JOBS_MAX_ATTEMPTS`, default 5)
- Retention policies (`JOBS_REMOVE_ON_COMPLETE` = 100, `JOBS_REMOVE_ON_FAIL` = 500)
- Helper exports `getJobQueue()` and `closeJobQueue()` to reuse a singleton queue/connection across workers and API routes

`src/queues/workers/restorationWorker.js` implements the BullMQ worker:

- Propagates W3C trace context (`traceparent`, `tracestate`) into worker spans
- Invokes the Restorator service to run the full Classifier → PromptEnhancer → Restorator pipeline
- Updates Firestore job status (`running`, `succeeded`, `failed`) and records timing metadata
- Issues credit refunds via `CreditsService` when jobs ultimately fail (using the job payload `creditsSpent`)
- Supports graceful shutdown on SIGINT/SIGTERM and can be executed locally with `npm run worker:restoration`

## Job Queue & Dead Letter Queue

The system uses BullMQ for async job processing with comprehensive failure handling.

### Queue Architecture

```
API Request → Main Queue → Worker → Success
                ↓
            Failed Job → DLQ → Manual Replay
```

### Queue Commands

```bash
# Start restoration worker
npm run worker:restoration

# With Doppler
doppler run -- npm run worker:restoration

# DLQ management
npm run jobs:replay -- list                    # List failed jobs
npm run jobs:replay -- stats                   # Show DLQ statistics
npm run jobs:replay -- replay <dlqJobId>       # Replay specific job
npm run jobs:replay -- replay-user <userId>    # Replay user's jobs
npm run jobs:replay -- cleanup                 # Clean old DLQ jobs

# With Doppler
doppler run -- npm run jobs:replay -- <command>
```

### Job Lifecycle

1. **Queued**: Job added to main restoration queue
2. **Active**: Worker picks up job and begins processing
3. **Completed**: Job finishes successfully
4. **Failed**: Job fails and retries (up to 5 attempts)
5. **Dead Letter**: Job exhausts retries and moves to DLQ
6. **Replayed**: Job manually replayed from DLQ

### Failure Handling

- **Automatic Retries**: 5 attempts with exponential backoff
- **Credit Refunds**: Automatic refund on job failure
- **DLQ Migration**: Failed jobs automatically moved to dead letter queue
- **Audit Trail**: All failures logged in Firestore with error details
- **Manual Recovery**: CLI tools for replaying failed jobs

### Monitoring

The system provides comprehensive queue monitoring:

- **Queue Stats**: Active, waiting, completed, failed job counts
- **DLQ Stats**: Dead letter queue depth and failure patterns
- **Job Tracking**: Individual job status and error details
- **Replay History**: Audit log of all replay attempts

### Production Operations

**Daily Maintenance:**
```bash
# Check queue health
doppler run -- npm run jobs:replay -- stats

# Clean up old jobs (automated, but can run manually)
doppler run -- npm run jobs:replay -- cleanup
```

**Incident Response:**
```bash
# List recent failures
doppler run -- npm run jobs:replay -- list 20

# Replay specific failed job
doppler run -- npm run jobs:replay -- replay dlq-<jobId>

# Bulk replay for affected user
doppler run -- npm run jobs:replay -- replay-user <userId>
```

### Configuration

Queue behavior is controlled by environment variables:

- `RESTORATION_BATCH_DELAY_MS` - Delay between batch job processing (default: 1000ms)
- `REDIS_URL` - Redis connection for queue storage
- `LOG_LEVEL` - Logging verbosity for queue operations

### Error Recovery

The DLQ system ensures no jobs are permanently lost:

1. **Automatic Migration**: Failed jobs move to DLQ after max retries
2. **Credit Protection**: Credits refunded automatically on failure
3. **Replay Safety**: Prevents double-refunding and duplicate processing
4. **Audit Trail**: Complete history of failures and replay attempts
5. **Cleanup**: Automatic removal of old DLQ jobs (30+ days)
