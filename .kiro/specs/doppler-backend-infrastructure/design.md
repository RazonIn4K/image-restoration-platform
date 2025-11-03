# Design Document

## Overview

This design implements a production-ready Express.js backend for AI-powered image restoration with Doppler-managed secrets, async job processing, comprehensive security, and full observability. The system follows HTTP best practices (202 Accepted for long-running operations), OWASP security guidelines, and OpenTelemetry instrumentation patterns.

### Key Design Decisions

1. **Async-First Architecture**: All restoration jobs use 202 Accepted + Location pattern to handle long-running AI operations without HTTP timeouts
2. **Direct GCS Upload/Download**: V4 Signed URLs enable browser-to-storage transfers, reducing Express server load and improving scalability
3. **Idempotency Guarantees**: Required Idempotency-Key headers prevent duplicate processing and enable safe retries
4. **Defense-in-Depth Security**: Magic number validation, SafeSearch moderation, EXIF stripping, and Helmet middleware protect against attacks
5. **OpenTelemetry Observability**: Distributed tracing with span propagation through queue messages enables end-to-end debugging
6. **Atomic Credit Management**: Redis DECR with Firestore sync ensures accurate billing and prevents race conditions

## Architecture

### System Components

```mermaid
graph TB
    subgraph Client Layer
        Browser[Browser/PWA]
    end

    subgraph API Layer
        Express[Express v1 API]
        Auth[Firebase Auth Middleware]
        Helmet[Helmet Security Headers]
        RateLimit[Rate Limit Middleware]
        Idempotency[Idempotency Middleware]
    end

    subgraph Service Layer
        Classifier[Classifier Service]
        Enhancer[Prompt Enhancer Service]
        Restorator[Restorator Service]
        Credits[Credits Service]
    end

    subgraph Client Layer
        GeminiClient[Gemini Client]
        FirestoreClient[Firestore Client]
        RedisClient[Redis Client]
    end

    subgraph Infrastructure
        Queue[BullMQ Job Queue]
        Worker[Queue Workers]
        DLQ[Dead Letter Queue]
    end

    subgraph Storage
        GCS[(GCS Buckets)]
        Firestore[(Firestore)]
        Redis[(Redis)]
    end

    subgraph Observability
        OTel[OpenTelemetry Collector]
        Logs[Structured Logs]
    end

    Browser -->|1. GET /v1/uploads/signed-url| Express
    Express --> Auth
    Auth --> Credits
    Credits --> RedisClient
    Express -->|2. Signed URL| Browser
    Browser -->|3. PUT image| GCS
    Browser -->|4. POST /v1/jobs| Express
    Express --> Idempotency
    Idempotency --> RateLimit
    RateLimit --> Queue
    Queue --> Worker
    Worker --> Classifier
    Classifier --> Enhancer
    Enhancer --> Restorator
    Restorator --> GeminiClient
    GeminiClient --> GCS
    Worker --> FirestoreClient
    Worker --> OTel
    Express --> Helmet
```

### Request Flow Sequence

```mermaid
sequenceDiagram
    participant Client
    participant Express as Express API
    participant Auth as Firebase Auth
    participant Credits as Credits Service
    participant Queue as BullMQ
    participant Worker
    participant Sharp
    participant SafeSearch as Vision SafeSearch
    participant Classifier
    participant Enhancer as Prompt Enhancer
    participant Restorator
    participant Gemini as Gemini Client
    participant GCS
    participant Firestore
    participant OTel as OpenTelemetry

    Client->>Express: GET /v1/uploads/signed-url
    Express->>Auth: Validate token
    Auth-->>Express: user_id
    Express->>GCS: Generate V4 signed URL (15min TTL)
    Express-->>Client: 200 {url, fields}
    
    Client->>GCS: PUT image (direct upload)
    GCS-->>Client: 200 OK
    
    Client->>Express: POST /v1/jobs (Idempotency-Key, gcs_ref)
    Express->>Auth: Validate token
    Auth-->>Express: user_id
    Express->>Credits: Check entitlement
    Credits->>Redis: DECR user:{id}:credits
    Redis-->>Credits: new_balance
    alt Insufficient credits
        Credits-->>Express: 402 Payment Required
        Express-->>Client: 402 {available_credits}
    end
    
    Express->>Queue: Enqueue job (trace_ctx, idem_key)
    Queue-->>Express: job_id
    Express->>Firestore: Create job record (queued)
    Express->>OTel: Emit span (enqueue)
    Express-->>Client: 202 Accepted + Location: /v1/jobs/{id}
    
    Queue->>Worker: Dequeue job (with trace_ctx)
    Worker->>OTel: Start span (process_job)
    Worker->>Firestore: Update status=running
    Worker->>GCS: Download original
    Worker->>Sharp: Preprocess (rotate, resize, strip EXIF)
    Worker->>SafeSearch: Moderate content
    alt Policy violation
        SafeSearch-->>Worker: likely/very_likely
        Worker->>Firestore: Update status=failed (moderation)
        Worker->>Credits: Refund credits
        Worker->>OTel: End span (error)
    end
    
    Worker->>Classifier: Analyze degradation
    Classifier-->>Worker: {blur: 0.8, noise: 0.3}
    Worker->>OTel: Emit span (classify, 120ms)
    
    Worker->>Enhancer: Generate prompt
    Enhancer-->>Worker: enhanced_prompt
    Worker->>OTel: Emit span (enhance, 50ms)
    
    Worker->>Restorator: Restore image
    Restorator->>Gemini: API call (with retry)
    Gemini-->>Restorator: restored_image
    Worker->>OTel: Emit span (restore, 8500ms)
    
    Worker->>GCS: Upload result
    Worker->>GCS: Generate V4 signed URL (15min)
    Worker->>Firestore: Update status=succeeded, timings, signed_url
    Worker->>OTel: End span (success)
    
    Client->>Express: GET /v1/jobs/{id}
    Express->>Auth: Validate token
    Express->>Firestore: Fetch job (verify ownership)
    Express-->>Client: 200 {status: succeeded, signed_url, timings}
    
    Client->>GCS: GET signed_url
    GCS-->>Client: Restored image
```

## Components and Interfaces

### 1. Express API Server

**Responsibilities:**
- Route handling for `/v1/**` endpoints
- Middleware orchestration (auth, rate limiting, idempotency, security headers)
- Request validation and error normalization
- Health check endpoints

**Key Interfaces:**

```typescript
// Error Response Schema (RFC 7807 application/problem+json)
interface ProblemDetails {
  type: string;             // URI reference (e.g., "/errors/insufficient-credits")
  title: string;            // Human-readable summary
  status: number;           // HTTP status code
  detail?: string;          // Human-readable explanation
  instance: string;         // Request ID for correlation
  [key: string]: any;       // Extension members (e.g., remainingCredits)
}

// Job Creation Request
interface CreateJobRequest {
  gcs_ref?: string;         // Reference to uploaded object
  user_prompt?: string;     // Optional custom prompt
  // Fallback: multipart image data (dev only)
}

// Job Creation Response (202)
interface CreateJobResponse {
  jobId: string;
  status: "queued";
  estimatedSeconds: number;
}

// Job Status Response
interface JobStatusResponse {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  timings?: {
    classify_ms: number;
    prompt_ms: number;
    restore_ms: number;
    total_ms: number;
  };
  signedUrl?: string;       // Present when status=succeeded
  error?: {
    type: string;
    title: string;
    detail: string;
  };
}

// SSE Event Stream (optional, reduces polling)
// GET /v1/jobs/{id}/stream
// Content-Type: text/event-stream
//
// event: status
// data: {"status":"running","progress":0.3}
//
// event: status
// data: {"status":"succeeded","signedUrl":"https://..."}
//
// event: error
// data: {"type":"/errors/moderation-rejected","detail":"..."}
```

**Middleware Stack:**

1. **Helmet**: CSP, HSTS, COOP, COEP, X-Content-Type-Options, X-Frame-Options
2. **Request ID**: Generate or extract X-Request-Id
3. **Trace Context**: Extract W3C traceparent/tracestate headers
4. **Firebase Auth**: Validate token, extract user_id
5. **Rate Limiting**: Token bucket per user + IP with RateLimit-* headers
6. **Idempotency**: Check Redis for duplicate Idempotency-Key (24h TTL)
7. **Body Parsing**: JSON + multipart (Multer fallback)
8. **OpenTelemetry**: Auto-instrumentation for HTTP
9. **Error Handler**: Normalize errors to RFC 7807 problem+json schema

**Standard Headers:**

```http
# Rate Limiting (all responses)
RateLimit-Limit: 60
RateLimit-Remaining: 42
RateLimit-Reset: 1800

# Rate Limit Exceeded
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 3
RateLimit-Remaining: 0
RateLimit-Reset: 43200
Retry-After: 43200
Content-Type: application/problem+json

# Idempotency Conflict
HTTP/1.1 409 Conflict
Idempotency-Key: 2c3f...e8
Content-Type: application/problem+json

# Service Unavailable
HTTP/1.1 503 Service Unavailable
Retry-After: 120
Content-Type: application/problem+json
```



### 2. Doppler Secrets Management

**Configuration Structure:**

```bash
# Required Doppler Secrets (all environments)
GEMINI_API_KEY=<google_ai_key>
FIRESTORE_CREDS=<base64_service_account_json>
REDIS_URL=redis://user:pass@host:6379
STRIPE_WEBHOOK_SECRET=whsec_...
FIREBASE_PROJECT_ID=<project_id>
LOG_LEVEL=info|debug
NODE_ENV=development|staging|production

# GCS Configuration
GCS_BUCKET_ORIGINALS=ai-restore-originals-prod
GCS_BUCKET_RESULTS=ai-restore-results-prod
UPLOAD_URL_TTL_SECONDS=900      # 15 minutes
RESULT_URL_TTL_SECONDS=900      # 15 minutes

# Lifecycle Policies
GCS_ORIGINALS_RETENTION_DAYS=30
GCS_RESULTS_RETENTION_DAYS=90

# OpenTelemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
OTEL_SERVICE_NAME=ai-restoration-api
```

**Startup Validation:**

```javascript
// server-node/src/config/doppler.js
const REQUIRED_SECRETS = [
  'GEMINI_API_KEY',
  'FIRESTORE_CREDS',
  'REDIS_URL',
  'FIREBASE_PROJECT_ID',
  'GCS_BUCKET_ORIGINALS',
  'GCS_BUCKET_RESULTS'
];

function validateSecrets() {
  const missing = REQUIRED_SECRETS.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required Doppler secrets:', missing);
    console.error('Run: doppler setup --project ai-restoration --config dev');
    process.exit(1);
  }
  
  console.log('✅ All Doppler secrets loaded');
}
```

**Fallback Behavior (Dev/CI):**

- **Redis**: In-memory Map for rate limits and idempotency when REDIS_URL absent
- **Firestore**: Mock client returning empty results when FIRESTORE_CREDS absent
- **Gemini**: Skip integration tests; unit tests use mocked responses

### 3. Service Layer Architecture

#### 3.1 Classifier Service

**Purpose:** Analyze image degradation types and confidence scores

**Interface:**

```typescript
interface DegradationAnalysis {
  blur: number;           // 0.0 - 1.0
  noise: number;
  lowLight: number;
  compression: number;
  scratch: number;
  fade: number;
  colorShift: number;
}

class ClassifierService {
  async analyze(imageBuffer: Buffer): Promise<DegradationAnalysis> {
    // Implementation uses lightweight CV algorithms or Gemini vision
    // Returns confidence scores for each degradation type
  }
}
```

**Design Rationale:**
- Lightweight classification (< 200ms) to avoid delaying restoration
- Multiple degradation types can coexist (e.g., blur + noise)
- Confidence scores guide prompt enhancement priority

#### 3.2 Prompt Enhancer Service

**Purpose:** Generate optimized Gemini prompts based on degradation analysis

**Interface:**

```typescript
interface PromptEnhancementInput {
  degradation: DegradationAnalysis;
  userPrompt?: string;
}

class PromptEnhancerService {
  async enhance(input: PromptEnhancementInput): Promise<string> {
    // Merge degradation-specific templates with user intent
    // Example output: "Restore this photo by reducing motion blur (high confidence)
    // and suppressing noise (medium confidence). Preserve facial features and skin tones."
  }
}
```

**Template Strategy:**

```javascript
const TEMPLATES = {
  blur: "reduce motion blur and sharpen edges",
  noise: "suppress grain and noise while preserving detail",
  lowLight: "enhance brightness and recover shadow detail",
  compression: "reduce JPEG artifacts and restore texture",
  scratch: "remove scratches and blemishes using inpainting",
  fade: "restore color vibrancy and contrast",
  colorShift: "correct color cast and white balance"
};

function buildPrompt(degradation, userPrompt) {
  const topIssues = Object.entries(degradation)
    .filter(([_, score]) => score > 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  
  const instructions = topIssues.map(([type, score]) => 
    `${TEMPLATES[type]} (${score > 0.8 ? 'high' : 'medium'} priority)`
  ).join(', ');
  
  return userPrompt 
    ? `${userPrompt}. Technical guidance: ${instructions}`
    : `Restore this photo by ${instructions}. Preserve natural appearance.`;
}
```

#### 3.3 Restorator Service

**Purpose:** Orchestrate AI restoration with retry logic and cost tracking

**Interface:**

```typescript
interface RestorationResult {
  imageBuffer: Buffer;
  providerRequestId: string;
  costEstimate: number;     // USD
  retryCount: number;
}

class RestoratorService {
  async restore(
    imageBuffer: Buffer,
    prompt: string,
    traceContext: object
  ): Promise<RestorationResult> {
    // Retry logic with exponential backoff
    // Record provider request IDs for billing reconciliation
  }
}
```

**Retry Strategy:**

```javascript
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelay: 1000,        // 1s
  maxDelay: 10000,        // 10s
  jitter: 0.3             // ±30% to avoid thundering herds
};

async function retryWithBackoff(fn, config) {
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === config.maxAttempts || !isRetryable(error)) {
        throw error;
      }
      
      // Exponential backoff with jitter
      const exponentialDelay = Math.min(
        config.baseDelay * Math.pow(2, attempt - 1),
        config.maxDelay
      );
      const jitter = exponentialDelay * config.jitter * (Math.random() * 2 - 1);
      const finalDelay = Math.max(0, exponentialDelay + jitter);
      
      await sleep(finalDelay);
    }
  }
}

function isRetryable(error) {
  return error.status === 429 ||  // Rate limit
         error.status === 503 ||  // Service unavailable
         error.code === 'ETIMEDOUT';
}
```

#### 3.4 Credits Service

**Purpose:** Atomic credit management with Redis and Firestore sync

**Interface:**

```typescript
interface CreditCheckResult {
  allowed: boolean;
  remainingCredits: number;
}

class CreditsService {
  async checkAndDeduct(userId: string, amount: number): Promise<CreditCheckResult> {
    // Atomic DECR in Redis with Firestore fallback
  }
  
  async refund(userId: string, jobId: string, amount: number): Promise<void> {
    // Atomic INCR with ledger entry
  }
}
```

**Implementation Strategy:**

```javascript
async function checkAndDeduct(userId, amount) {
  const cacheKey = `credits:${userId}`;
  
  // Try Redis first (60s TTL)
  let balance = await redis.get(cacheKey);
  
  if (balance === null) {
    // Cache miss: load from Firestore
    const doc = await firestore.collection('users').doc(userId).get();
    balance = doc.data().credits || 0;
    await redis.setex(cacheKey, 60, balance);
  }
  
  // Atomic decrement
  const newBalance = await redis.decr(cacheKey);
  
  if (newBalance < 0) {
    await redis.incr(cacheKey);  // Rollback
    return { allowed: false, remainingCredits: balance };
  }
  
  // Async sync to Firestore (fire-and-forget)
  firestore.collection('users').doc(userId).update({
    credits: newBalance,
    lastDeduction: FieldValue.serverTimestamp()
  });
  
  // Record in ledger
  firestore.collection('credit_ledger').add({
    userId,
    amount: -amount,
    balance: newBalance,
    timestamp: FieldValue.serverTimestamp()
  });
  
  return { allowed: true, remainingCredits: newBalance };
}
```



### 4. Client Layer

#### 4.1 Gemini Client

**Responsibilities:**
- Wrap Google Gemini 2.5 Flash Image API
- Handle authentication and request formatting
- Track provider request IDs and costs

**Configuration:**

```javascript
// clients/geminiClient.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiClient {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }
    this.client = new GoogleGenerativeAI(this.apiKey);
    this.model = this.client.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }
  
  async restoreImage(imageBuffer, prompt, traceContext) {
    const span = trace.getTracer('gemini-client').startSpan('gemini.restore', {
      parent: traceContext
    });
    
    try {
      const result = await this.model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } }
          ]
        }]
      });
      
      span.setAttributes({
        'gemini.request_id': result.requestId,
        'gemini.cost_usd': this.estimateCost(imageBuffer.length)
      });
      
      return {
        imageBuffer: Buffer.from(result.response.candidates[0].content.parts[0].inlineData.data, 'base64'),
        requestId: result.requestId,
        cost: this.estimateCost(imageBuffer.length)
      };
    } finally {
      span.end();
    }
  }
  
  estimateCost(imageSizeBytes) {
    // Gemini 2.5 Flash: ~$0.039 per 1024x1024 image
    const pixels = imageSizeBytes / 3; // Rough estimate
    const megapixels = pixels / 1_000_000;
    return megapixels * 0.039;
  }
}
```

#### 4.2 Firestore Client

**Responsibilities:**
- Job state persistence
- Credit ledger
- User metadata
- Audit logs

**Schema Design:**

```javascript
// Collections
users/{userId}
  - credits: number
  - dailyFreeUsed: number
  - dailyFreeResetAt: timestamp
  - stripeCustomerId: string
  - createdAt: timestamp

jobs/{jobId}
  - userId: string (indexed)
  - status: "queued" | "running" | "succeeded" | "failed"
  - gcsOriginalPath: string
  - gcsResultPath: string
  - signedResultUrl: string
  - timings: {
      classify_ms: number,
      prompt_ms: number,
      restore_ms: number,
      total_ms: number
    }
  - degradation: object
  - prompt: string
  - providerRequestId: string
  - costUsd: number
  - moderation: {
      adult: string,
      violence: string,
      racy: string
    }
  - error: { code: string, message: string }
  - createdAt: timestamp
  - updatedAt: timestamp

credit_ledger/{entryId}
  - userId: string (indexed)
  - jobId: string
  - amount: number (negative for deduction, positive for refund)
  - balance: number
  - type: "deduction" | "refund" | "purchase"
  - timestamp: timestamp
```

**Fallback Mock (Dev/CI):**

```javascript
class MockFirestoreClient {
  constructor() {
    this.data = new Map();
  }
  
  collection(name) {
    return {
      doc: (id) => ({
        get: async () => ({ exists: false, data: () => ({}) }),
        set: async (data) => { this.data.set(`${name}/${id}`, data); },
        update: async (data) => { /* no-op */ }
      }),
      add: async (data) => ({ id: 'mock-id' })
    };
  }
}
```

#### 4.3 Redis Client

**Responsibilities:**
- Rate limiting (token bucket)
- Idempotency key storage
- Credit balance cache
- Session management

**Key Patterns:**

```javascript
// Rate Limiting
ratelimit:user:{userId}:{window}  → count (TTL: window duration)
ratelimit:ip:{ip}:{window}        → count (TTL: window duration)

// Idempotency
idempotency:{userId}:{key}        → JSON response (TTL: 24h)

// Credits Cache
credits:{userId}                  → balance (TTL: 60s)

// Queue Metadata
queue:depth                       → count
queue:processing_rate             → gauge
```

**Token Bucket Implementation:**

```javascript
async function checkRateLimit(userId, limit, windowSeconds) {
  const key = `ratelimit:user:${userId}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  const count = await redis.incr(key);
  
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  
  const remaining = Math.max(0, limit - count);
  const resetAt = Math.ceil(Date.now() / 1000 / windowSeconds) * windowSeconds;
  
  return {
    allowed: count <= limit,
    limit,
    remaining,
    reset: resetAt
  };
}
```

**In-Memory Fallback:**

```javascript
class InMemoryRedisClient {
  constructor() {
    this.store = new Map();
    this.ttls = new Map();
  }
  
  async get(key) {
    if (this.isExpired(key)) {
      this.store.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.store.get(key) || null;
  }
  
  async setex(key, ttl, value) {
    this.store.set(key, value);
    this.ttls.set(key, Date.now() + ttl * 1000);
  }
  
  async incr(key) {
    const current = parseInt(this.store.get(key) || '0');
    const newValue = current + 1;
    this.store.set(key, newValue.toString());
    return newValue;
  }
  
  isExpired(key) {
    const expiry = this.ttls.get(key);
    return expiry && Date.now() > expiry;
  }
}
```

### 5. Job Queue Architecture

**Technology:** BullMQ (Redis-backed queue for Node.js)

**Queue Configuration:**

```javascript
// server-node/src/queue/restorationQueue.js
const { Queue, Worker } = require('bullmq');

const restorationQueue = new Queue('restoration', {
  connection: redisClient,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'custom',
      // Custom backoff with jitter to avoid thundering herds
      calculate: (attemptsMade) => {
        const baseDelay = 1000;
        const maxDelay = 30000;
        const jitter = 0.3;
        
        const exponentialDelay = Math.min(
          baseDelay * Math.pow(2, attemptsMade),
          maxDelay
        );
        const jitterAmount = exponentialDelay * jitter * (Math.random() * 2 - 1);
        return Math.max(0, exponentialDelay + jitterAmount);
      }
    },
    removeOnComplete: 100,  // Keep last 100 completed
    removeOnFail: 500       // Keep last 500 failed
  }
});

const worker = new Worker('restoration', async (job) => {
  // Extract W3C trace context from job data
  const traceparent = job.data.traceparent;
  const tracestate = job.data.tracestate;
  
  // Propagate trace context to create child span
  const parentContext = traceparent 
    ? propagation.extract(context.active(), { traceparent, tracestate })
    : context.active();
  
  const span = trace.getTracer('worker').startSpan('process_job', {
    attributes: {
      'job.id': job.id,
      'job.attempt': job.attemptsMade + 1,
      'user.id': job.data.userId
    }
  }, parentContext);
  
  try {
    await context.with(trace.setSpan(parentContext, span), async () => {
      await processRestorationJob(job.data);
    });
    
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;  // Trigger retry
  } finally {
    span.end();
  }
}, {
  connection: redisClient,
  concurrency: 5  // Process 5 jobs in parallel
});
```

**Dead Letter Queue:**

```javascript
worker.on('failed', async (job, error) => {
  if (job.attemptsMade >= job.opts.attempts) {
    // Move to DLQ
    await deadLetterQueue.add('failed-restoration', {
      originalJobId: job.id,
      data: job.data,
      error: {
        message: error.message,
        stack: error.stack
      },
      attempts: job.attemptsMade
    });
    
    // Refund credits
    await creditsService.refund(job.data.userId, job.id, 1);
    
    // Update Firestore
    await firestore.collection('jobs').doc(job.id).update({
      status: 'failed',
      error: {
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message
      },
      updatedAt: FieldValue.serverTimestamp()
    });
  }
});
```

**Replay Tooling:**

```javascript
// scripts/replayDLQ.js
async function replayFailedJobs(filter = {}) {
  const dlqJobs = await deadLetterQueue.getJobs(['completed']);
  
  for (const dlqJob of dlqJobs) {
    if (matchesFilter(dlqJob.data, filter)) {
      console.log(`Replaying job ${dlqJob.data.originalJobId}`);
      
      await restorationQueue.add('restoration', dlqJob.data.data, {
        jobId: dlqJob.data.originalJobId  // Preserve original ID
      });
      
      await dlqJob.remove();
    }
  }
}
```



## Data Models

### Job State Machine

```mermaid
stateDiagram-v2
    [*] --> queued: POST /v1/jobs
    queued --> running: Worker dequeue
    running --> succeeded: Restoration complete
    running --> failed: Error (non-retryable)
    running --> queued: Error (retryable, attempts < 5)
    failed --> [*]
    succeeded --> [*]
    
    note right of failed
        Credits refunded
        Moved to DLQ if max attempts
    end note
    
    note right of succeeded
        Signed URL generated
        GCS result stored
    end note
```

### GCS Storage Structure

```
Bucket: ai-restore-originals-prod
  └── {userId}/
      └── {jobId}/
          └── original.jpg

Bucket: ai-restore-results-prod
  └── {userId}/
      └── {jobId}/
          └── result.jpg

Lifecycle Policies:
  - originals: Delete after 30 days
  - results: Delete after 90 days
```

### Idempotency Key Lifecycle

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Redis
    
    Client->>API: POST /v1/jobs (Idempotency-Key: abc123)
    API->>Redis: SETNX idempotency:user:123:abc123
    Redis-->>API: 1 (key set)
    API->>Redis: SETEX (24h TTL)
    API->>Redis: SET value = {jobId, response}
    API-->>Client: 202 {jobId: xyz}
    
    Note over Client: Network error, retry
    
    Client->>API: POST /v1/jobs (Idempotency-Key: abc123, same payload)
    API->>Redis: GET idempotency:user:123:abc123
    Redis-->>API: {jobId: xyz, response: {...}}
    API-->>Client: 202 {jobId: xyz} (cached)
    
    Note over Client: Retry with different payload
    
    Client->>API: POST /v1/jobs (Idempotency-Key: abc123, DIFFERENT payload)
    API->>Redis: GET idempotency:user:123:abc123
    Redis-->>API: {jobId: xyz, originalPayload: {...}}
    API-->>Client: 409 Conflict (payload mismatch)
```

## Error Handling

### Error Code Taxonomy (RFC 7807)

```javascript
const PROBLEM_TYPES = {
  // Client Errors (4xx)
  INVALID_REQUEST: {
    type: '/errors/invalid-request',
    title: 'Invalid Request',
    status: 400
  },
  UNAUTHORIZED: {
    type: '/errors/unauthorized',
    title: 'Unauthorized',
    status: 401
  },
  INSUFFICIENT_CREDITS: {
    type: '/errors/insufficient-credits',
    title: 'Insufficient Credits',
    status: 402
  },
  FORBIDDEN: {
    type: '/errors/forbidden',
    title: 'Forbidden',
    status: 403
  },
  NOT_FOUND: {
    type: '/errors/not-found',
    title: 'Not Found',
    status: 404
  },
  IDEMPOTENCY_MISMATCH: {
    type: '/errors/idempotency-mismatch',
    title: 'Idempotency Key Conflict',
    status: 409
  },
  PAYLOAD_TOO_LARGE: {
    type: '/errors/payload-too-large',
    title: 'Payload Too Large',
    status: 413
  },
  MODERATION_REJECTED: {
    type: '/errors/moderation-rejected',
    title: 'Content Policy Violation',
    status: 422
  },
  RATE_LIMIT_EXCEEDED: {
    type: '/errors/rate-limit-exceeded',
    title: 'Rate Limit Exceeded',
    status: 429
  },
  
  // Server Errors (5xx)
  INTERNAL_ERROR: {
    type: '/errors/internal-error',
    title: 'Internal Server Error',
    status: 500
  },
  SERVICE_UNAVAILABLE: {
    type: '/errors/service-unavailable',
    title: 'Service Unavailable',
    status: 503
  },
  GATEWAY_TIMEOUT: {
    type: '/errors/gateway-timeout',
    title: 'Gateway Timeout',
    status: 504
  }
};
```

### Error Middleware (RFC 7807)

```javascript
// server-node/src/middleware/errorHandler.js
function errorHandler(err, req, res, next) {
  const requestId = req.id;
  
  // Log with trace context
  logger.error({
    requestId,
    traceId: req.traceContext?.traceId,
    error: {
      code: err.code,
      message: err.message,
      stack: err.stack
    },
    userId: req.userId,
    path: req.path
  });
  
  // Map to RFC 7807 problem+json
  const problemType = PROBLEM_TYPES[err.code] || PROBLEM_TYPES.INTERNAL_ERROR;
  
  const problem = {
    type: problemType.type,
    title: problemType.title,
    status: problemType.status,
    detail: err.message,
    instance: requestId,
    ...err.extensions  // Additional fields (e.g., remainingCredits)
  };
  
  res.status(problemType.status)
    .set('Content-Type', 'application/problem+json')
    .json(problem);
}
```

### Retry-After Header Strategy

```javascript
function setRetryAfter(res, errorCode, context = {}) {
  switch (errorCode) {
    case 'RATE_LIMIT_EXCEEDED':
      // Token bucket reset time
      res.set('Retry-After', context.resetIn || 60);
      break;
      
    case 'SERVICE_UNAVAILABLE':
      // Queue backpressure
      res.set('Retry-After', context.queueWaitEstimate || 30);
      break;
      
    case 'PAYLOAD_TOO_LARGE':
      // Temporary if queue is full
      if (context.temporary) {
        res.set('Retry-After', 120);
      }
      break;
  }
}
```

## Testing Strategy

### Unit Tests (Jest)

**Coverage Targets:**
- Services: 90% line coverage
- Clients: 80% line coverage (mocked external APIs)
- Middleware: 85% line coverage

**Example Test Structure:**

```javascript
// tests/unit/services/classifier.test.js
describe('ClassifierService', () => {
  let classifier;
  
  beforeEach(() => {
    classifier = new ClassifierService();
  });
  
  describe('analyze', () => {
    it('should detect blur in motion-blurred image', async () => {
      const imageBuffer = await loadFixture('blur-high.jpg');
      const result = await classifier.analyze(imageBuffer);
      
      expect(result.blur).toBeGreaterThan(0.7);
      expect(result.noise).toBeLessThan(0.3);
    });
    
    it('should detect multiple degradations', async () => {
      const imageBuffer = await loadFixture('blur-noise-combined.jpg');
      const result = await classifier.analyze(imageBuffer);
      
      expect(result.blur).toBeGreaterThan(0.5);
      expect(result.noise).toBeGreaterThan(0.5);
    });
    
    it('should handle corrupt JPEG gracefully', async () => {
      const corruptBuffer = Buffer.from([0xFF, 0xD8, 0x00, 0x00]);  // Invalid JPEG
      
      await expect(classifier.analyze(corruptBuffer))
        .rejects.toThrow('Invalid image format');
    });
  });
});
```

### Integration Tests

**Smoke Test Script:**

```javascript
// scripts/smokeRestore.js
const axios = require('axios');
const fs = require('fs');

async function smokeTest() {
  const API_URL = process.env.API_URL || 'http://localhost:3000';
  const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN;
  
  if (!AUTH_TOKEN) {
    console.log('⏭️  No TEST_AUTH_TOKEN; skipping smoke test');
    process.exit(0);
  }
  
  console.log('🔥 Starting smoke test...');
  
  // 1. Get signed upload URL
  const uploadRes = await axios.get(`${API_URL}/v1/uploads/signed-url`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
  });
  console.log('✅ Got signed upload URL');
  
  // 2. Upload test image
  const imageBuffer = fs.readFileSync('tests/fixtures/test-image.jpg');
  await axios.put(uploadRes.data.url, imageBuffer, {
    headers: { 'Content-Type': 'image/jpeg' }
  });
  console.log('✅ Uploaded test image');
  
  // 3. Create restoration job
  const jobRes = await axios.post(`${API_URL}/v1/jobs`, {
    gcs_ref: uploadRes.data.objectPath
  }, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Idempotency-Key': crypto.randomUUID()
    }
  });
  
  expect(jobRes.status).toBe(202);
  expect(jobRes.data.jobId).toBeDefined();
  console.log(`✅ Created job ${jobRes.data.jobId}`);
  
  // 4. Poll for completion
  let attempts = 0;
  while (attempts < 30) {
    const statusRes = await axios.get(`${API_URL}/v1/jobs/${jobRes.data.jobId}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    
    if (statusRes.data.status === 'succeeded') {
      console.log('✅ Job succeeded');
      console.log(`   Timings: ${JSON.stringify(statusRes.data.timings)}`);
      
      // 5. Download result
      const resultRes = await axios.get(statusRes.data.signedUrl);
      expect(resultRes.headers['content-type']).toBe('image/jpeg');
      console.log('✅ Downloaded result');
      
      return;
    }
    
    if (statusRes.data.status === 'failed') {
      throw new Error(`Job failed: ${statusRes.data.error.message}`);
    }
    
    await sleep(2000);
    attempts++;
  }
  
  throw new Error('Job timeout after 60s');
}

smokeTest().catch(err => {
  console.error('❌ Smoke test failed:', err.message);
  process.exit(1);
});
```

### Fuzz Tests

```javascript
// tests/fuzz/imageParser.test.js
const { generateCorruptJPEG, generateCorruptPNG } = require('./generators');

describe('Image Parser Fuzz Tests', () => {
  it('should handle truncated JPEG headers', async () => {
    for (let i = 0; i < 100; i++) {
      const corrupt = generateCorruptJPEG({ truncateAt: Math.random() * 1000 });
      
      await expect(sharp(corrupt).metadata())
        .rejects.toThrow();  // Should fail gracefully, not crash
    }
  });
  
  it('should reject polyglot files', async () => {
    const polyglot = Buffer.concat([
      Buffer.from('<?php system($_GET["cmd"]); ?>'),
      fs.readFileSync('tests/fixtures/valid.jpg')
    ]);
    
    const detected = await fileType.fromBuffer(polyglot);
    expect(detected.mime).not.toBe('image/jpeg');  // Should detect as text/php
  });
});
```

### Property Tests

```javascript
// tests/property/exifStripping.test.js
const fc = require('fast-check');

describe('EXIF Stripping Property Tests', () => {
  it('should never return images with GPS data', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1000, maxLength: 100000 }),
        async (randomBytes) => {
          try {
            const processed = await sharp(randomBytes)
              .rotate()  // Auto-orient
              .jpeg({ quality: 85 })
              .toBuffer();
            
            const metadata = await sharp(processed).metadata();
            expect(metadata.exif).toBeUndefined();
          } catch (err) {
            // Invalid input is acceptable; just ensure no crash
            expect(err).toBeDefined();
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
```



## Security Architecture

### Content Security Policy (Helmet)

```javascript
// server-node/src/middleware/security.js
const helmet = require('helmet');

const cspConfig = {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'strict-dynamic'"],  // Remove unsafe-inline in prod
    styleSrc: ["'self'", "'unsafe-inline'"],    // Tailwind requires this
    imgSrc: ["'self'", "blob:", "data:", "https://storage.googleapis.com"],
    connectSrc: [
      "'self'",
      process.env.API_URL,
      "https://storage.googleapis.com"
    ],
    workerSrc: ["'self'"],
    frameSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
  },
  reportOnly: process.env.CSP_REPORT_ONLY === 'true',
  reportUri: process.env.CSP_REPORT_URI
};

app.use(helmet({
  contentSecurityPolicy: cspConfig,
  hsts: {
    maxAge: 31536000,  // 1 year
    includeSubDomains: true,
    preload: true
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true
}));
```

### File Upload Security (OWASP)

```javascript
// server-node/src/middleware/uploadSecurity.js
const fileType = require('file-type');
const multer = require('multer');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE = 10 * 1024 * 1024;  // 10 MB

const upload = multer({
  limits: {
    fileSize: MAX_SIZE,
    files: 1
  },
  fileFilter: async (req, file, cb) => {
    // Reject based on extension alone
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      return cb(new Error('Invalid file extension'));
    }
    
    // Check for compound extensions
    if (file.originalname.match(/\.(php|exe|sh|bat)\./i)) {
      return cb(new Error('Suspicious filename pattern'));
    }
    
    cb(null, true);
  }
});

async function validateMagicNumbers(req, res, next) {
  if (!req.file) return next();
  
  const detected = await fileType.fromBuffer(req.file.buffer);
  
  if (!detected || !ALLOWED_TYPES.includes(detected.mime)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_FILE_TYPE',
        message: `Detected type ${detected?.mime || 'unknown'} not allowed`,
        requestId: req.id
      }
    });
  }
  
  req.file.detectedMime = detected.mime;
  next();
}
```

### SafeSearch Moderation

```javascript
// server-node/src/services/moderation.js
const vision = require('@google-cloud/vision');

class ModerationService {
  constructor() {
    this.client = new vision.ImageAnnotatorClient({
      credentials: JSON.parse(Buffer.from(process.env.FIRESTORE_CREDS, 'base64'))
    });
  }
  
  async moderate(imageBuffer) {
    const [result] = await this.client.safeSearchDetection({
      image: { content: imageBuffer }
    });
    
    const safeSearch = result.safeSearchAnnotation;
    
    const flags = {
      adult: safeSearch.adult,
      violence: safeSearch.violence,
      racy: safeSearch.racy,
      spoof: safeSearch.spoof,
      medical: safeSearch.medical
    };
    
    const rejected = ['adult', 'violence', 'racy'].some(category =>
      ['LIKELY', 'VERY_LIKELY'].includes(flags[category])
    );
    
    return {
      allowed: !rejected,
      flags
    };
  }
}
```

### Authentication Middleware

```javascript
// server-node/src/middleware/auth.js
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(Buffer.from(process.env.FIRESTORE_CREDS, 'base64'))
  ),
  projectId: process.env.FIREBASE_PROJECT_ID
});

async function authenticateFirebase(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header',
        requestId: req.id
      }
    });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.userId = decodedToken.uid;
    req.userEmail = decodedToken.email;
    next();
  } catch (error) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid auth token',
        requestId: req.id,
        details: { reason: error.code }
      }
    });
  }
}
```

## Observability

### OpenTelemetry Setup

```javascript
// server-node/src/instrumentation.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'ai-restoration-api',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces'
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/metrics'
    }),
    exportIntervalMillis: 60000  // 1 minute
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': { enabled: true },
      '@opentelemetry/instrumentation-express': { enabled: true },
      '@opentelemetry/instrumentation-redis': { enabled: true }
    })
  ]
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OpenTelemetry shut down'))
    .catch(err => console.error('Error shutting down OpenTelemetry', err))
    .finally(() => process.exit(0));
});
```

### Structured Logging

```javascript
// server-node/src/utils/logger.js
const pino = require('pino');
const { trace, context } = require('@opentelemetry/api');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      hostname: bindings.hostname
    })
  },
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    
    const spanContext = span.spanContext();
    return {
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      trace_flags: spanContext.traceFlags
    };
  }
});

// Request logger middleware
function requestLogger(req, res, next) {
  req.log = logger.child({
    requestId: req.id,
    userId: req.userId,
    method: req.method,
    path: req.path
  });
  
  const start = Date.now();
  
  res.on('finish', () => {
    req.log.info({
      status: res.statusCode,
      duration_ms: Date.now() - start
    }, 'Request completed');
  });
  
  next();
}
```

### Custom Metrics

```javascript
// server-node/src/metrics/custom.js
const { metrics } = require('@opentelemetry/api');

const meter = metrics.getMeter('ai-restoration-api');

const requestCounter = meter.createCounter('http_requests_total', {
  description: 'Total HTTP requests'
});

const requestDuration = meter.createHistogram('http_request_duration_ms', {
  description: 'HTTP request duration in milliseconds'
});

const queueDepth = meter.createObservableGauge('queue_depth', {
  description: 'Current job queue depth'
});

const creditBalance = meter.createObservableGauge('user_credit_balance', {
  description: 'User credit balance'
});

const providerCost = meter.createCounter('provider_cost_usd', {
  description: 'Total cost of provider API calls in USD'
});

// Usage in middleware
function metricsMiddleware(req, res, next) {
  const start = Date.now();
  
  res.on('finish', () => {
    requestCounter.add(1, {
      method: req.method,
      route: req.route?.path || 'unknown',
      status: res.statusCode
    });
    
    requestDuration.record(Date.now() - start, {
      method: req.method,
      route: req.route?.path || 'unknown'
    });
  });
  
  next();
}
```

### Health Check Implementation

```javascript
// server-node/src/routes/health.js
const express = require('express');
const router = express.Router();

router.get('/live', (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/ready', async (req, res) => {
  const checks = {
    redis: false,
    firestore: false,
    gcs: false
  };
  
  const degradedReasons = [];
  
  // Check Redis
  try {
    await redisClient.ping();
    checks.redis = true;
  } catch (err) {
    if (process.env.REDIS_URL) {
      degradedReasons.push('Redis unreachable');
    } else {
      checks.redis = true;  // In-memory fallback OK
      degradedReasons.push('Redis using in-memory fallback');
    }
  }
  
  // Check Firestore
  try {
    await firestoreClient.collection('_health').doc('check').get();
    checks.firestore = true;
  } catch (err) {
    if (process.env.FIRESTORE_CREDS) {
      degradedReasons.push('Firestore unreachable');
    } else {
      checks.firestore = true;  // Mock OK
      degradedReasons.push('Firestore using mock');
    }
  }
  
  // Check GCS
  try {
    await gcsClient.bucket(process.env.GCS_BUCKET_ORIGINALS).exists();
    checks.gcs = true;
  } catch (err) {
    degradedReasons.push('GCS unreachable');
  }
  
  const allHealthy = Object.values(checks).every(v => v);
  const status = allHealthy && degradedReasons.length === 0 ? 'healthy' : 'degraded';
  const httpStatus = allHealthy ? 200 : 503;
  
  res.status(httpStatus).json({
    status,
    checks,
    degraded_reasons: degradedReasons,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
```

## API Contract (OpenAPI 3.1)

### OpenAPI Specification

```yaml
openapi: 3.1.0
info:
  title: AI Image Restoration API
  version: 1.0.0
  description: Production-ready API for AI-powered image restoration

servers:
  - url: https://api.example.com/v1
    description: Production
  - url: https://staging-api.example.com/v1
    description: Staging

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
  
  schemas:
    ProblemDetails:
      type: object
      required: [type, title, status, instance]
      properties:
        type:
          type: string
          format: uri-reference
        title:
          type: string
        status:
          type: integer
        detail:
          type: string
        instance:
          type: string
          format: uuid
    
    JobResponse:
      type: object
      required: [jobId, status, createdAt, updatedAt]
      properties:
        jobId:
          type: string
          format: uuid
        status:
          type: string
          enum: [queued, running, succeeded, failed]
        createdAt:
          type: string
          format: date-time
        updatedAt:
          type: string
          format: date-time
        timings:
          type: object
          properties:
            classify_ms:
              type: number
            prompt_ms:
              type: number
            restore_ms:
              type: number
            total_ms:
              type: number
        signedUrl:
          type: string
          format: uri
        error:
          $ref: '#/components/schemas/ProblemDetails'

paths:
  /uploads/signed-url:
    get:
      summary: Get signed upload URL
      security:
        - bearerAuth: []
      responses:
        '200':
          description: Signed URL for direct GCS upload
          content:
            application/json:
              schema:
                type: object
                properties:
                  url:
                    type: string
                    format: uri
                  objectPath:
                    type: string
                  expiresAt:
                    type: string
                    format: date-time
        '401':
          description: Unauthorized
          content:
            application/problem+json:
              schema:
                $ref: '#/components/schemas/ProblemDetails'
  
  /jobs:
    post:
      summary: Create restoration job
      security:
        - bearerAuth: []
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [gcs_ref]
              properties:
                gcs_ref:
                  type: string
                user_prompt:
                  type: string
      responses:
        '202':
          description: Job accepted
          headers:
            Location:
              schema:
                type: string
                format: uri
            RateLimit-Limit:
              schema:
                type: integer
            RateLimit-Remaining:
              schema:
                type: integer
            RateLimit-Reset:
              schema:
                type: integer
          content:
            application/json:
              schema:
                type: object
                properties:
                  jobId:
                    type: string
                    format: uuid
                  status:
                    type: string
                    enum: [queued]
                  estimatedSeconds:
                    type: integer
        '402':
          description: Insufficient credits
          content:
            application/problem+json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/ProblemDetails'
                  - type: object
                    properties:
                      remainingCredits:
                        type: integer
        '409':
          description: Idempotency key conflict
          content:
            application/problem+json:
              schema:
                $ref: '#/components/schemas/ProblemDetails'
        '429':
          description: Rate limit exceeded
          headers:
            Retry-After:
              schema:
                type: integer
          content:
            application/problem+json:
              schema:
                $ref: '#/components/schemas/ProblemDetails'
  
  /jobs/{id}:
    get:
      summary: Get job status
      security:
        - bearerAuth: []
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Job status
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/JobResponse'
        '404':
          description: Job not found
          content:
            application/problem+json:
              schema:
                $ref: '#/components/schemas/ProblemDetails'
  
  /jobs/{id}/stream:
    get:
      summary: Stream job status updates (SSE)
      security:
        - bearerAuth: []
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Event stream
          content:
            text/event-stream:
              schema:
                type: string
```

## Deployment Considerations

### Environment-Specific Configuration

```javascript
// Development
doppler setup --project ai-restoration --config dev
doppler run -- npm run dev

// Staging
doppler setup --project ai-restoration --config staging
doppler run -- npm start

// Production
doppler setup --project ai-restoration --config prod
doppler run -- node server-node/src/server.js
```

### CI/CD Integration

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    
    env:
      DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install Doppler CLI
        run: |
          curl -Ls https://cli.doppler.com/install.sh | sh
      
      - name: Install dependencies
        run: npm ci
      
      - name: Lint
        run: doppler run -- npm run lint
      
      - name: Security audit
        run: npm audit --audit-level=high
      
      - name: Unit tests
        run: doppler run -- npm test
      
      - name: Start API (background)
        run: |
          doppler run -- node server-node/src/server.js > api.log 2>&1 &
          sleep 5
      
      - name: Smoke test
        run: |
          if [ -z "$GEMINI_API_KEY" ]; then
            echo "⏭️  No secrets; skipping smoke test"
            exit 0
          fi
          doppler run -- node scripts/smokeRestore.js
      
      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: api-logs
          path: api.log
```

### Docker Configuration

```dockerfile
# server-node/Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install Doppler CLI
RUN wget -q -t3 'https://packages.doppler.com/public/cli/rsa.8004D9FF50437357.key' -O /etc/apk/keys/cli@doppler-8004D9FF50437357.rsa.pub && \
    echo 'https://packages.doppler.com/public/cli/alpine/any-version/main' | tee -a /etc/apk/repositories && \
    apk add doppler

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["doppler", "run", "--", "node", "src/server.js"]
```

## Design Rationale Summary

### Why Async-First (202 Accepted)?
- AI restoration typically takes 5-30 seconds, exceeding typical HTTP timeouts
- Enables horizontal scaling of workers independent of API servers
- Provides better UX with progress updates via polling or SSE

### Why Idempotency Keys?
- Mobile networks are unreliable; clients need safe retry semantics
- Prevents double-billing when users retry failed requests
- Standard pattern used by Stripe, AWS, and other production APIs

### Why Direct GCS Upload/Download?
- Reduces Express server CPU/memory by 80%+ for large images
- Improves p95 latency by eliminating proxy overhead
- Simplifies horizontal scaling (stateless API servers)

### Why OpenTelemetry?
- Vendor-neutral observability (works with Datadog, New Relic, Grafana, etc.)
- Distributed tracing across API → Queue → Worker → Gemini
- Single instrumentation for traces, metrics, and logs

### Why Redis + Firestore?
- Redis: Fast reads for rate limits, idempotency, credit cache
- Firestore: Durable storage for jobs, ledger, audit logs
- Fallback to in-memory for dev/CI without infrastructure

### Why BullMQ?
- Production-proven queue with at-least-once delivery
- Built-in retry with exponential backoff
- Dead-letter queue for failed jobs
- Excellent observability (queue depth, processing rate)

This design balances production-readiness, developer experience, and operational simplicity while following industry best practices for HTTP APIs, security, and observability.
