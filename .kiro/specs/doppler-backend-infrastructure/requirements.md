# Requirements Document

## Introduction

This feature establishes secure secrets management via Doppler and implements the core backend infrastructure for the AI Image Restoration Platform. The system will provide a production-ready Express.js backend with proper environment variable management, service architecture for AI-powered image restoration, and comprehensive safety mechanisms for file uploads and processing.

## Glossary

- **Doppler**: Cloud-based secrets management platform that provides secure environment variable injection
- **Express Backend**: Node.js web application framework serving as the primary API runtime (v1)
- **Gemini Client**: Service wrapper for Google's Gemini 2.5 Flash Image API
- **Firestore Client**: Service wrapper for Google Cloud Firestore database operations
- **Redis Client**: Service wrapper for Redis in-memory data store (rate limiting, caching, idempotency)
- **Classifier Service**: Component that analyzes image degradation types
- **Prompt Enhancer Service**: Component that generates optimized restoration prompts
- **Restorator Service**: Component that orchestrates the image restoration workflow
- **Credits Service**: Component that manages user credit allocation and consumption
- **Multer**: Express middleware for handling multipart/form-data file uploads
- **Sharp**: High-performance Node.js image processing library
- **EXIF**: Exchangeable Image File Format metadata embedded in images
- **Idempotency Key**: UUIDv4 header ensuring duplicate requests return cached responses without reprocessing
- **Service Token**: Doppler credential for CI/CD environments to access secrets
- **GCS**: Google Cloud Storage bucket for storing original and restored images
- **V4 Signed URL**: Time-limited pre-authenticated URL for direct browser-to-GCS uploads/downloads
- **OpenTelemetry**: Observability framework for distributed tracing, metrics, and structured logging
- **Helmet**: Express middleware providing secure HTTP headers (CSP, HSTS, etc.)
- **SafeSearch**: Google Vision API content moderation service
- **Job Queue**: Asynchronous task queue for long-running image restoration operations
- **Token Bucket**: Rate limiting algorithm that allows burst traffic while enforcing average rate limits

## Requirements

### Requirement 0

**User Story:** As an API consumer, I want stable versioned endpoints with consistent error responses, so that my client code can handle failures predictably across all API operations

#### Acceptance Criteria

1. THE Express Backend SHALL expose all public endpoints under `/v1/` path prefix
2. THE Express Backend SHALL return error responses with consistent JSON structure containing error code, message, requestId, and optional details object
3. WHEN a request includes X-Request-Id header, THE Express Backend SHALL echo that value in error responses
4. WHERE X-Request-Id header is absent, THE Express Backend SHALL generate a UUIDv4 request identifier
5. THE Express Backend SHALL include the request identifier in all structured log entries for request correlation

### Requirement 1

**User Story:** As a developer, I want all secrets managed through Doppler, so that credentials are never committed to version control and environment configuration is consistent across dev/staging/prod

#### Acceptance Criteria

1. WHEN the Express Backend starts without Doppler configuration, THEN the Express Backend SHALL terminate with exit code 1 and display the specific missing secret keys
2. THE Express Backend SHALL load all required secrets (GEMINI_API_KEY, FIRESTORE_CREDS, REDIS_URL, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_API_URL, LOG_LEVEL) from Doppler
3. WHERE Doppler secrets are unavailable in development or CI environments, THE Express Backend SHALL switch to in-memory mock implementations for Redis Client and Firestore Client
4. THE Express Backend SHALL provide npm scripts that wrap all commands with `doppler run --` prefix
5. WHEN CI workflows execute, THE Express Backend SHALL authenticate using the Doppler Service Token from GitHub Actions secrets

### Requirement 2

**User Story:** As a backend developer, I want a clear service architecture with separated concerns, so that each component can be developed, tested, and maintained independently

#### Acceptance Criteria

1. THE Express Backend SHALL implement Classifier Service as an isolated module in `services/classifier.js`
2. THE Express Backend SHALL implement Prompt Enhancer Service as an isolated module in `services/promptEnhancer.js`
3. THE Express Backend SHALL implement Restorator Service as an isolated module in `services/restorator.js`
4. THE Express Backend SHALL implement Credits Service as an isolated module in `services/credits.js`
5. THE Express Backend SHALL implement Gemini Client in `clients/geminiClient.js` with credential loading from Doppler
6. THE Express Backend SHALL implement Firestore Client in `clients/firestoreClient.js` with fallback to mock when credentials are absent
7. THE Express Backend SHALL implement Redis Client in `clients/redisClient.js` with fallback to in-memory implementation when REDIS_URL is absent
8. WHEN any service module is instantiated, THE service SHALL validate its required dependencies and fail fast with descriptive error messages

### Requirement 3

**User Story:** As an API consumer, I want asynchronous job-based image restoration with idempotency guarantees, so that long-running operations don't timeout and duplicate submissions are handled safely

#### Acceptance Criteria

1. THE Express Backend SHALL expose GET `/v1/uploads/signed-url` endpoint that returns a V4 Signed URL for direct browser-to-GCS upload
2. THE Express Backend SHALL expose POST `/v1/jobs` endpoint accepting job metadata and either a GCS object reference or multipart image data
3. WHEN a POST request to `/v1/jobs` is received, THE Express Backend SHALL require Idempotency-Key header containing a UUIDv4
4. WHEN an Idempotency Key is replayed with identical payload, THE Express Backend SHALL return the original job response without creating a duplicate job
5. WHEN an Idempotency Key is replayed with different payload, THE Express Backend SHALL return HTTP 409 Conflict with error details
6. WHEN a job is created, THE Express Backend SHALL return HTTP 202 Accepted with JSON body containing jobId, status "queued", and estimatedSeconds
7. THE Express Backend SHALL include Location header pointing to `/v1/jobs/{jobId}` in 202 responses
8. THE Express Backend SHALL expose GET `/v1/jobs/{id}` endpoint returning job status (queued, running, succeeded, failed), timing metrics, and signed result URL when succeeded
9. WHEN preprocessing an image, THE Express Backend SHALL use `sharp().rotate()` without arguments to auto-orient via EXIF
10. WHEN preprocessing an image, THE Express Backend SHALL strip all EXIF metadata and reattach only sRGB ICC color profile if needed
11. WHEN an image exceeds 2048 pixels in any dimension, THE Express Backend SHALL resize preserving aspect ratio and compress JPEG to quality 85
12. WHEN a job enters running state, THE Express Backend SHALL invoke Classifier Service, Prompt Enhancer Service, and Restorator Service in sequence
13. THE Express Backend SHALL record classify_ms, prompt_ms, restore_ms, and total processing time for each job
14. WHEN a job completes successfully, THE Express Backend SHALL store the result in GCS and generate a V4 Signed URL valid for 15 minutes
15. THE Express Backend SHALL support optional `?mode=sync` query parameter for small images with server timeout of 30 seconds maximum

### Requirement 4

**User Story:** As a security engineer, I want defense-in-depth file upload validation following OWASP guidelines, so that malicious files, policy violations, and privacy leaks are prevented

#### Acceptance Criteria

1. THE Express Backend SHALL detect file type by content magic numbers using file-type library and server-side MIME detection
2. THE Express Backend SHALL reject files based on client-provided Content-Type header or filename extension alone
3. THE Express Backend SHALL accept only files with detected MIME types image/jpeg, image/png, or image/webp
4. THE Express Backend SHALL reject files with compound extensions (e.g., .jpg.php) or suspicious filename patterns
5. THE Express Backend SHALL enforce a maximum file size of 10 MB via Multer configuration
6. WHEN a file exceeds size limits, THE Express Backend SHALL return HTTP 413 Content Too Large with optional Retry-After header
7. THE Express Backend SHALL generate randomized UUIDv4 filenames and ignore client-provided filenames for storage paths
8. THE Express Backend SHALL store all uploaded files in private GCS buckets with no public access
9. THE Express Backend SHALL invoke Google Vision SafeSearch API before any AI processing
10. WHEN SafeSearch detects "likely" or "very likely" ratings for Adult, Violence, or Racy content, THE Express Backend SHALL return HTTP 422 Unprocessable Content and reject the job
11. THE Express Backend SHALL record moderation flags (adult, violence, racy, spoof, medical) in Firestore job records for audit
12. THE Express Backend SHALL strip all EXIF metadata including GPS coordinates and device identifiers during preprocessing
13. THE Express Backend SHALL set Cache-Control header to `private, no-store` on all API responses containing signed URLs or base64 data
14. THE Express Backend SHALL never cache V4 Signed URLs in service workers or CDN layers

### Requirement 5

**User Story:** As a platform operator, I want comprehensive health checks, storage lifecycle policies, and rate limiting with standard headers, so that the system is observable, compliant, and client-friendly

#### Acceptance Criteria

1. THE Express Backend SHALL expose GET `/health/live` endpoint that returns HTTP 200 unconditionally
2. THE Express Backend SHALL expose GET `/health/ready` endpoint that verifies connectivity to Redis Client, Firestore Client, and GCS
3. WHEN dependencies are unreachable, THE `/health/ready` endpoint SHALL return HTTP 503 with JSON listing unavailable dependencies
4. WHERE Doppler secrets are absent in development, THE `/health/ready` endpoint SHALL return HTTP 200 with status "degraded" and degraded_reasons array
5. THE Express Backend SHALL include average and p95 response time measurements in `/health/ready` responses
6. THE Express Backend SHALL configure GCS Lifecycle policies to auto-delete original images after N days and results after M days (configurable via Doppler)
7. THE Express Backend SHALL provide all artifact access via V4 Signed URLs with no public bucket access
8. THE Express Backend SHALL implement Token Bucket rate limiting per user ID and per IP address using Redis Client
9. THE Express Backend SHALL include RateLimit-Limit, RateLimit-Remaining, and RateLimit-Reset headers on all API responses
10. WHEN rate limits are exceeded, THE Express Backend SHALL return HTTP 429 Too Many Requests with Retry-After header in seconds
11. WHEN the Job Queue is paused or at capacity, THE Express Backend SHALL return HTTP 503 Service Unavailable with Retry-After header

### Requirement 6

**User Story:** As a developer, I want comprehensive testing with OpenTelemetry observability, so that I can verify correctness, debug production issues, and optimize performance

#### Acceptance Criteria

1. THE Express Backend SHALL provide Jest unit tests for Classifier Service covering classification logic
2. THE Express Backend SHALL provide Jest unit tests for Prompt Enhancer Service covering prompt generation
3. THE Express Backend SHALL provide Jest unit tests for Restorator Service covering orchestration flow
4. THE Express Backend SHALL provide Jest unit tests for Credits Service covering credit deduction and validation
5. THE Express Backend SHALL provide fuzz tests for corrupt or partial JPEG/PNG headers to verify graceful error handling
6. THE Express Backend SHALL provide property tests verifying that processed images never contain EXIF GPS fields
7. WHERE real API credentials are unavailable in CI, THE Express Backend SHALL skip integration tests and log "No secrets; skipping integration tests"
8. THE Express Backend SHALL provide at least one integration smoke test for `/v1/jobs` that runs only when `process.env.CI` is not set
9. THE Express Backend SHALL instrument all HTTP requests with OpenTelemetry traces including spans for classifier, promptEnhancer, restorator, and storage operations
10. THE Express Backend SHALL correlate structured logs with trace_id, span_id, and requestId fields
11. THE Express Backend SHALL emit OpenTelemetry metrics for request count, duration histograms, error rates, and queue depth
12. THE Express Backend SHALL export OpenTelemetry data to stdout in development and to a collector endpoint in production

### Requirement 7

**User Story:** As a DevOps engineer, I want CI workflows with security scanning and Helmet protection, so that deployments are safe, compliant, and follow security best practices

#### Acceptance Criteria

1. THE Express Backend SHALL provide GitHub Actions workflow that installs dependencies via `npm ci`
2. THE Express Backend SHALL run linting via `doppler run -- npm run lint` in CI
3. THE Express Backend SHALL run unit tests via `doppler run -- npm test` in CI
4. THE Express Backend SHALL run `npm audit --audit-level=high` and fail the build on high-severity vulnerabilities
5. THE Express Backend SHALL start the API server in background via `doppler run -- node server-node/index.js` for smoke tests
6. WHEN Doppler Service Token is present in CI, THE Express Backend SHALL execute smoke test script `doppler run -- node scripts/smokeRestore.js`
7. WHEN Doppler Service Token is absent in CI, THE smoke test step SHALL skip with exit code 0 and log "No secrets; skipping smoke"
8. THE Express Backend SHALL enable GitHub Dependabot for automated dependency updates
9. THE Express Backend SHALL enable GitHub CodeQL for security scanning
10. THE Express Backend SHALL use Helmet middleware to set secure HTTP headers including CSP, HSTS, X-Content-Type-Options, and X-Frame-Options
11. THE Express Backend SHALL configure Content-Security-Policy with documented baseline for script-src, img-src, connect-src, and worker-src directives
12. THE Express Backend SHALL enable HSTS with max-age of at least 31536000 seconds in production
13. THE Express Backend SHALL provide CSP report-uri or report-to endpoint for policy violation monitoring in staging

### Requirement 8.1

**User Story:** As a system architect, I want well-defined queue semantics with retry policies and dead-letter handling, so that async jobs are reliable and failures are debuggable

#### Acceptance Criteria

1. THE Express Backend SHALL use BullMQ (Node) or equivalent queue system with at-least-once delivery guarantees
2. THE Job Queue SHALL implement exponential backoff with jitter for failed jobs with maximum retry count of 5
3. WHEN a job exhausts all retries, THE Job Queue SHALL move the job to a dead-letter queue for manual inspection
4. THE Job Queue SHALL persist job state (queued, running, succeeded, failed) in Firestore with timestamps
5. THE Express Backend SHALL provide replay tooling to resubmit jobs from the dead-letter queue after fixes
6. THE Job Queue SHALL propagate trace context (trace_id, span_id) and Idempotency-Key through queue messages for distributed tracing
7. THE Job Queue SHALL record queue depth, processing rate, and wait time metrics via OpenTelemetry

### Requirement 8.2

**User Story:** As a security engineer, I want authentication and authorization on all API endpoints, so that only authenticated users can submit jobs and access their results

#### Acceptance Criteria

1. THE Express Backend SHALL require Firebase Auth token in Authorization header for all `/v1/jobs` and `/v1/uploads` endpoints
2. THE Express Backend SHALL extract and validate user ID from Firebase Auth token before processing requests
3. THE Express Backend SHALL return HTTP 401 Unauthorized when Authorization header is missing or invalid
4. THE Express Backend SHALL scope all V4 Signed URLs to the requesting user ID to prevent unauthorized access
5. THE Express Backend SHALL verify that GET `/v1/jobs/{id}` requests can only access jobs owned by the authenticated user
6. THE Express Backend SHALL return HTTP 403 Forbidden when a user attempts to access another user's job
7. THE Express Backend SHALL include user ID in all structured logs and OpenTelemetry spans for audit trails

### Requirement 8.3

**User Story:** As a product owner, I want the core degradation classification and prompt enhancement pipeline implemented, so that restoration quality is optimized for each image type

#### Acceptance Criteria

1. THE Classifier Service SHALL analyze uploaded images and return degradation taxonomy (blur, noise, low-light, compression, scratch, fade, color-shift)
2. THE Classifier Service SHALL support multiple simultaneous degradation types with confidence scores
3. THE Prompt Enhancer Service SHALL accept degradation classification and optional user prompt as inputs
4. THE Prompt Enhancer Service SHALL generate optimized Gemini prompts using templates tailored to each degradation type
5. WHEN a user provides a custom prompt, THE Prompt Enhancer Service SHALL merge user intent with degradation-specific guidance
6. THE Restorator Service SHALL invoke Gemini Client with enhanced prompt and preprocessed image
7. WHEN Gemini Client returns an error or timeout, THE Restorator Service SHALL retry up to 3 times with exponential backoff
8. IF all Gemini retries fail, THE Restorator Service SHALL mark the job as failed and record the provider error in Firestore
9. THE Restorator Service SHALL record provider request IDs and cost estimates in job metadata for billing reconciliation

### Requirement 8.4

**User Story:** As a product manager, I want credits and entitlements enforced before job processing, so that free tier limits and paid credits are respected accurately

#### Acceptance Criteria

1. THE Credits Service SHALL check user entitlement before enqueuing any job
2. THE Credits Service SHALL implement atomic credit decrement using Redis DECR command with check-and-set semantics
3. WHEN a user has insufficient credits, THE Express Backend SHALL return HTTP 402 Payment Required with available credit count
4. THE Credits Service SHALL cache user credit balances in Redis with TTL of 60 seconds and fallback to Firestore
5. WHEN a job fails before completion, THE Credits Service SHALL refund credits atomically and log the refund transaction
6. THE Credits Service SHALL sync credit transactions to Firestore for audit and Stripe reconciliation
7. THE Credits Service SHALL enforce daily free tier limits (2-3 restorations per day) for users without paid credits
8. THE Credits Service SHALL record credit deductions with job ID, user ID, timestamp, and amount in Firestore ledger

### Requirement 8.5

**User Story:** As a security engineer, I want signed URLs with strict TTL and single-use semantics, so that artifacts cannot be accessed after expiration or by unauthorized parties

#### Acceptance Criteria

1. THE Express Backend SHALL generate V4 Signed URLs for uploads with TTL of 15 minutes configured via Doppler
2. THE Express Backend SHALL generate V4 Signed URLs for download results with TTL of 15 minutes configured via Doppler
3. THE Express Backend SHALL scope all signed URLs to specific GCS object paths preventing directory traversal
4. THE Express Backend SHALL include user ID in GCS object metadata for access audit trails
5. THE Express Backend SHALL never return the same signed URL twice for security-sensitive operations
6. WHERE signed URL TTL values are configurable, THE Express Backend SHALL load TTL from Doppler secrets (UPLOAD_URL_TTL_SECONDS, RESULT_URL_TTL_SECONDS)
7. THE Express Backend SHALL log signed URL generation events with user ID, object path, and expiration timestamp

### Requirement 8

**User Story:** As a backend developer and API consumer, I want comprehensive documentation including OpenAPI specs and client examples, so that integration is straightforward and API contracts are clear

#### Acceptance Criteria

1. THE Express Backend SHALL provide `docs/IMPLEMENTATION_GUIDE.md` documenting all required Doppler secrets with fallback behaviors
2. THE `docs/IMPLEMENTATION_GUIDE.md` SHALL list all npm scripts with Doppler wrapper commands
3. THE `docs/IMPLEMENTATION_GUIDE.md` SHALL document health endpoint contracts including degraded_reasons field format
4. THE `docs/IMPLEMENTATION_GUIDE.md` SHALL document structured log field names (requestId, userId, jobId, trace_id, span_id, phase timings)
5. THE `docs/IMPLEMENTATION_GUIDE.md` SHALL document GCS Lifecycle policy configuration and retention periods
6. THE Express Backend SHALL provide `docs/UPLOAD-SAFETY-CHECKLIST.md` documenting OWASP file validation, magic number checks, SafeSearch moderation, and EXIF stripping
7. THE Express Backend SHALL provide `docs/CSP-POLICY-GUIDE.md` documenting Content-Security-Policy directives and report-to configuration
8. THE Express Backend SHALL provide OpenAPI 3.1 specification for all `/v1/**` endpoints including request/response schemas
9. THE OpenAPI specification SHALL document all error codes (400, 409, 413, 422, 429, 503) with Retry-After header usage
10. THE Express Backend SHALL provide example curl commands and Postman collection for common workflows
11. THE Express Backend SHALL document moderation policy explaining when jobs are rejected with HTTP 422
12. THE Express Backend SHALL document Idempotency-Key behavior including 409 conflict scenarios and TTL window
