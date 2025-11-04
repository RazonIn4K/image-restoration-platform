# Implementation Plan

- [x] 1. Set up Doppler secrets management and project structure
  - Create `.kiro/specs/doppler-backend-infrastructure` directory structure
  - Initialize Doppler project with dev/staging/prod configs
  - Add startup validation script that checks required secrets and exits with error if missing
  - Create npm scripts wrapped with `doppler run --` for dev, test, lint commands
  - Document Doppler setup in `docs/IMPLEMENTATION_GUIDE.md`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 8.1, 8.2_

- [x] 2. Implement core Express server with middleware stack
  - [x] 2.1 Create Express app with Helmet security headers (CSP, HSTS, COOP, COEP)
    - Configure Content-Security-Policy with documented baseline directives
    - Enable HSTS with 31536000 max-age for production
    - Add COOP and COEP headers for future isolation features
    - _Requirements: 7.10, 7.11, 7.12_
  
  - [x] 2.2 Implement request ID and W3C trace context middleware
    - Generate or extract X-Request-Id header
    - Extract traceparent and tracestate headers for distributed tracing
    - Attach request ID and trace context to req object
    - _Requirements: 0.3, 0.4, 0.5_
  
  - [x] 2.3 Implement Firebase Auth middleware
    - Validate Bearer token from Authorization header
    - Extract user ID and email from decoded token
    - Return 401 with RFC 7807 problem+json for invalid/missing tokens
    - _Requirements: 8.2.1, 8.2.2, 8.2.3_
  
  - [x] 2.4 Implement rate limiting middleware with IETF standard headers
    - Create token bucket implementation using Redis
    - Track limits per user ID and per IP address
    - Return RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset on all responses
    - Return 429 with Retry-After header when limits exceeded
    - _Requirements: 5.8, 5.9, 5.10_
  
  - [x] 2.5 Implement idempotency middleware
    - Require Idempotency-Key header (UUIDv4) on POST /v1/jobs
    - Store original payload hash and response in Redis with 24h TTL
    - Return cached response for duplicate keys with identical payload
    - Return 409 Conflict for duplicate keys with different payload
    - _Requirements: 3.3, 3.4, 3.5_
  
  - [x] 2.6 Implement RFC 7807 error handler middleware
    - Map application errors to problem+json format with type URIs
    - Include requestId as instance field
    - Set Content-Type: application/problem+json
    - Log errors with trace context
    - _Requirements: 0.2, 0.3, 0.4_

- [x] 3. Implement client layer (Gemini, Firestore, Redis, GCS)
  - [x] 3.1 Create Gemini Client with retry logic
    - Initialize Google Generative AI client with API key from Doppler
    - Implement restoreImage method with OpenTelemetry span instrumentation
    - Add exponential backoff with jitter (3 attempts, ±30% jitter)
    - Track provider request IDs and cost estimates
    - _Requirements: 2.5, 8.3.6, 8.3.7, 8.3.8, 8.3.9_
  
  - [x] 3.2 Create Firestore Client with mock fallback
    - Initialize Firebase Admin SDK with credentials from Doppler
    - Implement job state persistence methods
    - Implement credit ledger methods
    - Create mock client for dev/CI when credentials absent
    - _Requirements: 1.3, 2.6_
  
  - [x] 3.3 Create Redis Client with in-memory fallback
    - Initialize Redis connection with URL from Doppler
    - Implement rate limit token bucket methods
    - Implement idempotency key storage methods
    - Implement credit balance cache methods
    - Create in-memory Map fallback when Redis unavailable
    - _Requirements: 1.3, 2.7_
  
  - [x] 3.4 Create GCS Client for signed URLs and lifecycle
    - Initialize Google Cloud Storage client
    - Implement V4 signed URL generation for uploads (15min TTL)
    - Implement V4 signed URL generation for downloads (15min TTL)
    - Configure lifecycle policies (originals 30d, results 90d)
    - Set Content-Disposition headers on download URLs
    - _Requirements: 5.6, 5.7, 8.5.1, 8.5.2, 8.5.3, 8.5.4, 8.5.5, 8.5.6, 8.5.7_

- [x] 4. Implement service layer (Classifier, Prompt Enhancer, Restorator, Credits)
  - [x] 4.1 Create Classifier Service
    - Implement image degradation analysis (blur, noise, low-light, compression, scratch, fade, color-shift)
    - Return confidence scores for each degradation type
    - Support multiple simultaneous degradation types
    - Add OpenTelemetry span instrumentation
    - _Requirements: 8.3.1, 8.3.2_
  
  - [x] 4.2 Create Prompt Enhancer Service
    - Implement degradation-specific prompt templates
    - Merge user custom prompts with degradation guidance
    - Prioritize top 3 degradation types by confidence
    - Add OpenTelemetry span instrumentation
    - _Requirements: 8.3.3, 8.3.4, 8.3.5_
  
  - [x] 4.3 Create Restorator Service
    - Orchestrate Classifier → Enhancer → Gemini Client workflow
    - Implement retry logic with exponential backoff and jitter
    - Record provider request IDs and cost estimates
    - Add OpenTelemetry span instrumentation for each phase
    - _Requirements: 8.3.6, 8.3.7, 8.3.8, 8.3.9_
  
  - [x] 4.4 Create Credits Service
    - Implement atomic credit check and deduct using Redis DECR
    - Return 402 Payment Required when credits insufficient
    - Cache credit balances in Redis with 60s TTL
    - Implement refund logic for failed jobs
    - Sync transactions to Firestore ledger
    - Enforce daily free tier limits (2-3 per day)
    - _Requirements: 8.4.1, 8.4.2, 8.4.3, 8.4.4, 8.4.5, 8.4.6, 8.4.7, 8.4.8_
  
  - [x] 4.5 Create Moderation Service
    - Initialize Google Vision SafeSearch client
    - Implement content moderation with documented thresholds
    - Reject images with LIKELY/VERY_LIKELY ratings for adult/violence/racy
    - Return moderation flags for audit logging
    - _Requirements: 4.9, 4.10, 4.11_

- [x] 5. Implement file upload security and preprocessing
  - [x] 5.1 Create upload validation middleware
    - Configure Multer with 10 MB size limit and single file constraint
    - Implement magic number validation using file-type library
    - Reject files based on detected MIME type, not extension
    - Reject compound extensions (.jpg.php) and suspicious patterns
    - Return 413 Content Too Large with optional Retry-After
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  
- [x] 5.2 Create image preprocessing pipeline with Sharp
    - Implement auto-orient using sharp().rotate() without arguments
    - Resize images exceeding 2048px preserving aspect ratio
    - Compress JPEG to quality 85
    - Strip all EXIF metadata including GPS
    - Reattach only sRGB ICC color profile if needed
    - _Requirements: 3.9, 3.10, 3.11, 4.12_
  
  - [x] 5.3 Implement SafeSearch moderation integration
    - Call Vision SafeSearch API before job processing
    - Return 422 Unprocessable Content for policy violations
    - Record moderation flags in Firestore job records
    - _Requirements: 4.9, 4.10, 4.11_

- [ ] 6. Implement async job queue with BullMQ
- [x] 6.1 Create BullMQ queue configuration
    - Initialize queue with Redis connection
    - Configure custom backoff strategy with jitter (±30%)
    - Set max attempts to 5 with exponential backoff
    - Configure job retention (100 completed, 500 failed)
    - _Requirements: 8.1.1, 8.1.2_
  
  - [ ] 6.2 Create queue worker with trace context propagation
    - Extract W3C traceparent/tracestate from job data
    - Create child span with propagated context
    - Process job through Classifier → Enhancer → Restorator pipeline
    - Update Firestore job status (queued → running → succeeded/failed)
    - Record timing metrics (classify_ms, prompt_ms, restore_ms, total_ms)
    - _Requirements: 8.1.6, 3.12, 3.13_
  
  - [ ] 6.3 Implement dead-letter queue and replay tooling
    - Move exhausted jobs to DLQ after max attempts
    - Trigger credit refunds for failed jobs
    - Create replay script to resubmit jobs from DLQ
    - _Requirements: 8.1.3, 8.1.4, 8.1.5_

- [ ] 7. Implement API endpoints
  - [x] 7.1 Implement GET /v1/uploads/signed-url
    - Validate Firebase Auth token
    - Generate V4 signed URL for GCS upload (15min TTL)
    - Return URL, object path, and expiration timestamp
    - Include user ID in GCS object metadata
    - _Requirements: 3.1, 8.5.1, 8.5.4_
  
  - [x] 7.2 Implement POST /v1/jobs
    - Validate Idempotency-Key header
    - Check user credits via Credits Service
    - Enqueue job with trace context (traceparent/tracestate)
    - Create Firestore job record with status=queued
    - Return 202 Accepted with Location header
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  
  - [x] 7.3 Implement GET /v1/jobs/{id}
    - Validate Firebase Auth token
    - Verify job ownership (user ID match)
    - Return 403 Forbidden for unauthorized access
    - Fetch job status from Firestore
    - Return job details with signed result URL when succeeded
    - _Requirements: 3.8, 8.2.5, 8.2.6_
  
  - [ ] 7.4 Implement GET /v1/jobs/{id}/stream (SSE)
    - Validate Firebase Auth token and job ownership
    - Stream job status updates as Server-Sent Events
    - Send status events (queued, running, succeeded, failed)
    - Close stream on job completion or error
    - _Requirements: 3.8, 3.14_

- [ ] 8. Implement health check endpoints
  - [ ] 8.1 Implement GET /health/live
    - Return 200 OK unconditionally
    - _Requirements: 5.1_
  
  - [ ] 8.2 Implement GET /health/ready
    - Check Redis connectivity (or in-memory fallback status)
    - Check Firestore connectivity (or mock status)
    - Check GCS bucket existence
    - Return 200 with degraded status and reasons when using fallbacks
    - Return 503 when required dependencies unreachable
    - Include average and p95 response times
    - _Requirements: 5.2, 5.3, 5.4, 5.5_

- [ ] 9. Implement OpenTelemetry observability
  - [ ] 9.1 Configure OpenTelemetry SDK
    - Initialize NodeSDK with OTLP exporters
    - Enable auto-instrumentations (HTTP, Express, Redis)
    - Configure service name from Doppler
    - Set up graceful shutdown on SIGTERM
    - _Requirements: 6.9, 6.10_
  
  - [ ] 9.2 Implement structured logging with Pino
    - Configure log level from Doppler
    - Add mixin to include trace_id and span_id in logs
    - Create request logger middleware
    - Log request completion with duration
    - _Requirements: 6.10, 8.2.7_
  
  - [ ] 9.3 Implement custom metrics
    - Create counters for HTTP requests by route and status
    - Create histogram for request duration
    - Create observable gauge for queue depth
    - Create counter for provider costs
    - _Requirements: 6.11_

- [ ] 10. Create comprehensive test suite
  - [ ] 10.1 Write unit tests for services
    - Test Classifier Service with fixture images (blur, noise, combined)
    - Test Prompt Enhancer Service with various degradation inputs
    - Test Restorator Service orchestration flow
    - Test Credits Service atomic operations
    - Target 90% line coverage for services
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  
  - [ ] 10.2 Write fuzz tests for image parsing
    - Generate corrupt JPEG/PNG headers
    - Test graceful error handling for invalid images
    - Test polyglot file rejection
    - _Requirements: 6.5_
  
  - [ ] 10.3 Write property tests for EXIF stripping
    - Verify processed images never contain GPS data
    - Test with random byte arrays
    - Run 50+ iterations with fast-check
    - _Requirements: 6.6_
  
  - [ ] 10.4 Create integration smoke test
    - Test complete workflow: signed URL → upload → job creation → polling → download
    - Skip when Doppler secrets unavailable in CI
    - Validate returned image is valid JPEG
    - _Requirements: 6.7, 6.8_

- [ ] 11. Set up CI/CD pipeline
  - [ ] 11.1 Create GitHub Actions workflow
    - Install Doppler CLI
    - Run npm ci for dependency installation
    - Run linting with doppler run
    - Run npm audit with high severity threshold
    - Run unit tests with doppler run
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  
  - [ ] 11.2 Configure security scanning
    - Enable GitHub Dependabot for dependency updates
    - Enable GitHub CodeQL for security analysis
    - _Requirements: 7.8, 7.9_
  
  - [ ] 11.3 Add smoke test to CI
    - Start API server in background
    - Run smoke test script when secrets available
    - Skip gracefully with exit 0 when secrets absent
    - Upload API logs on failure
    - _Requirements: 7.5, 7.6, 7.7_

- [ ] 12. Create comprehensive documentation
  - [ ] 12.1 Document Doppler setup and commands
    - List all required secrets with descriptions
    - Document npm scripts with doppler run wrappers
    - Explain fallback behavior for dev/CI
    - Document health endpoint contracts
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  
  - [ ] 12.2 Create upload safety checklist
    - Document OWASP file validation steps
    - Document magic number checks
    - Document SafeSearch moderation thresholds
    - Document EXIF stripping process
    - _Requirements: 8.6_
  
  - [ ] 12.3 Create CSP policy guide
    - Document Content-Security-Policy directives
    - Document report-to configuration
    - Explain COOP/COEP headers
    - _Requirements: 8.7_
  
  - [ ] 12.4 Create OpenAPI specification
    - Document all /v1/** endpoints
    - Include request/response schemas
    - Document all error codes with Retry-After usage
    - Provide example curl commands
    - Create Postman collection
    - _Requirements: 8.8, 8.9, 8.10_
  
  - [ ] 12.5 Document moderation policy and idempotency
    - Explain when jobs are rejected with 422
    - Document Idempotency-Key behavior
    - Explain 409 conflict scenarios
    - Document 24h TTL window
    - _Requirements: 8.11, 8.12_

- [ ] 13. Create Docker configuration
  - Create Dockerfile with Doppler CLI
  - Configure health check using /health/live endpoint
  - Set up multi-stage build for production
  - Document docker-compose setup for local development
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
