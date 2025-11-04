import { Router } from 'express';
import { randomUUID } from 'crypto';
import { trace, context } from '@opentelemetry/api';

import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { handleUpload, validateUploadedImage } from '../middleware/uploadValidation.js';
import { preprocessBuffer, preprocessImage } from '../middleware/imagePreprocess.js';
import { moderateBuffer, moderateImage } from '../middleware/moderateImage.js';
import { createProblem } from '../utils/problem.js';
import { runMiddleware } from '../utils/runMiddleware.js';
import { getJobQueue } from '../queues/jobQueue.js';

const ACCEPTED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEFAULT_CREDIT_COST = Number(process.env.JOBS_SINGLE_RESTORE_CREDIT ?? 1);
const SSE_HEARTBEAT_INTERVAL_MS = Number(process.env.JOBS_SSE_HEARTBEAT_MS ?? 30000);

function buildTraceparentFromSpan(span) {
  const spanContext = span.spanContext();
  if (!spanContext?.traceId || !spanContext?.spanId) {
    return null;
  }
  return `00-${spanContext.traceId}-${spanContext.spanId}-01`;
}

function normalizeContentType(value) {
  if (!value) return 'image/jpeg';
  const normalized = value.toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.has(normalized)) {
    throw createProblem({
      type: 'https://docs.image-restoration.ai/problem/unsupported-media-type',
      title: 'Unsupported Media Type',
      status: 415,
      detail: 'Only JPEG, PNG, or WebP uploads are supported for signed URLs.',
    });
  }
  return normalized;
}

async function buildJobResponse({ jobId, data, req }) {
  const response = {
    jobId,
    status: data.status ?? 'unknown',
    createdAt: data.createdAt?.toDate?.().toISOString?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.().toISOString?.() ?? null,
    timings: data.timings ?? null,
    prompt: data.prompt ?? null,
    credit: data.credit ?? null,
    moderation: data.moderation ?? null,
    preprocessing: data.preprocessing ?? null,
    error: data.error ?? null,
  };

  if (response.status === 'succeeded' && data.resultObjectName) {
    const download = await req.clients.gcs.generateDownloadUrl({
      userId: req.user.id,
      objectName: data.resultObjectName,
      filename: `${jobId}.jpg`,
    });
    response.result = {
      downloadUrl: download.url,
      expiresAt: download.expiresAt,
      objectName: data.resultObjectName,
    };
  }

  return response;
}

export function createJobsRouter({ redisStore }) {
  const router = Router();

  router.get('/uploads/signed-url', async (req, res, next) => {
    const span = trace.getTracer('api').startSpan('uploads.signedUrl');
    const ctx = trace.setSpan(context.active(), span);

    try {
      await context.with(ctx, async () => {
        const contentType = normalizeContentType(req.query.contentType ?? 'image/jpeg');
        const upload = await req.clients.gcs.generateUploadUrl({
          userId: req.user.id,
          contentType,
        });

        res.json({
          uploadUrl: upload.url,
          objectName: upload.objectName,
          expiresAt: upload.expiresAt,
          contentType,
        });
      });
    } catch (error) {
      next(error);
    } finally {
      span.end();
    }
  });

  router.post(
    '/jobs',
    idempotencyMiddleware({ store: redisStore }),
    async (req, res, next) => {
      const tracer = trace.getTracer('api');
      const span = tracer.startSpan('jobs.enqueue');
      const ctx = trace.setSpan(context.active(), span);

      let creditsReserved = 0;
      let jobId;

      try {
        await context.with(ctx, async () => {
          const isMultipart = req.is('multipart/form-data');
          let imageBuffer;
          let preprocessing;
          let moderation;
          let userPrompt = req.body?.prompt ?? null;

          if (isMultipart) {
            await runMiddleware(req, res, handleUpload('image'));
            await runMiddleware(req, res, validateUploadedImage);
            await runMiddleware(req, res, preprocessImage);
            await runMiddleware(req, res, moderateImage);

            imageBuffer = req.file.buffer;
            preprocessing = {
              operations: req.file.preprocessOperations,
              processedMetadata: req.file.processedMetadata,
              originalMetadata: req.file.originalMetadata,
              size: req.file.size,
              mime: req.file.detectedMime,
            };
            moderation = req.moderation;
          } else {
            const { source } = req.body ?? {};
            if (!source || source.type !== 'gcs' || !source.objectName) {
              throw createProblem({
                type: 'https://docs.image-restoration.ai/problem/invalid-payload',
                title: 'Invalid Job Payload',
                status: 400,
                detail: 'Provide a valid source object reference or upload an image file.',
              });
            }

            const downloaded = await req.clients.gcs.downloadObject({
              userId: req.user.id,
              objectName: source.objectName,
            });

            const preprocessResult = await preprocessBuffer(downloaded.buffer);
            imageBuffer = preprocessResult.buffer;
            preprocessing = {
              operations: preprocessResult.operations,
              processedMetadata: preprocessResult.processedMetadata,
              originalMetadata: preprocessResult.originalMetadata,
              size: preprocessResult.size,
              mime: preprocessResult.mime,
            };

            const contextInfo = {
              userId: req.user.id,
              jobId: source.jobId ?? null,
              requestId: req.context?.requestId,
            };
            moderation = await moderateBuffer(req.services.moderation, imageBuffer, contextInfo);
          }

          if (userPrompt && typeof userPrompt === 'string') {
            userPrompt = userPrompt.trim();
            if (userPrompt.length === 0) {
              userPrompt = null;
            }
          }

          jobId = randomUUID();
          const creditCost = DEFAULT_CREDIT_COST;
          const creditResult = await req.services.credits.checkAndDeduct({
            userId: req.user.id,
            amount: creditCost,
            jobId,
          });

          if (!creditResult.allowed) {
            throw createProblem({
              type: 'https://docs.image-restoration.ai/problem/insufficient-credits',
              title: 'Insufficient Credits',
              status: 402,
              detail: 'Additional credits are required to start a restoration job.',
            });
          }

          creditsReserved = creditCost;
          const creditType = creditResult.type ?? 'paid';

          await req.clients.firestore.collection('restorations').doc(jobId).set({
            status: 'queued',
            userId: req.user.id,
            createdAt: new Date(),
            prompt: userPrompt,
            credit: {
              amount: creditCost,
              type: creditType,
            },
            preprocessing,
            moderation: moderation ? {
              flags: moderation.flags,
              confidence: moderation.confidence,
            } : null,
          });

          const queue = getJobQueue();
          const traceparent = buildTraceparentFromSpan(span) ?? req.context?.traceparent ?? null;

         await queue.add('restoration', {
            jobId,
            userId: req.user.id,
            userPrompt,
            imageBuffer: imageBuffer.toString('base64'),
            preprocessing,
            moderation,
            creditsSpent: creditCost,
            creditType,
            traceparent,
            tracestate: req.context?.tracestate ?? null,
          }, {
            jobId,
          });

          const location = `/v1/jobs/${jobId}`;
          res.status(202).set('Location', location).json({
            jobId,
            status: 'queued',
            credit: {
              amount: creditCost,
              type: creditType,
            },
            location,
          });

          span.setAttributes({
            'job.id': jobId,
            'job.status': 'queued',
            'job.credit.amount': creditCost,
            'job.credit.type': creditType,
            'job.traceparent': traceparent ?? 'none',
          });
          span.addEvent('job_enqueued');
        });
      } catch (error) {
        if (creditsReserved > 0 && jobId) {
          try {
            await req.services.credits.refund({
              userId: req.user.id,
              jobId,
              amount: creditsReserved,
              reason: 'Job enqueue failed',
            });
          } catch (refundError) {
            req.clients.logger?.error('[jobs] Failed to refund credits after enqueue failure', {
              jobId,
              error: refundError?.message,
            });
          }
        }

        next(error);
      } finally {
        span.end();
      }
    }
  );

  router.get('/jobs/:id', async (req, res, next) => {
    try {
      const jobId = req.params.id;
      const doc = await req.clients.firestore.collection('restorations').doc(jobId).get();

      if (!doc.exists) {
        throw createProblem({
          type: 'https://docs.image-restoration.ai/problem/job-not-found',
          title: 'Job Not Found',
          status: 404,
          detail: 'No job with the provided identifier exists.',
        });
      }

      const data = doc.data();
      if (data.userId && data.userId !== req.user.id) {
        throw createProblem({
          type: 'https://docs.image-restoration.ai/problem/job-not-found',
          title: 'Job Not Found',
          status: 404,
          detail: 'No job with the provided identifier exists.',
        });
      }

      const response = await buildJobResponse({ jobId, data, req });
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get('/jobs/:id/stream', async (req, res, next) => {
    const jobId = req.params.id;

    try {
      const docRef = req.clients.firestore.collection('restorations').doc(jobId);
      const snapshot = await docRef.get();

      if (!snapshot.exists) {
        throw createProblem({
          type: 'https://docs.image-restoration.ai/problem/job-not-found',
          title: 'Job Not Found',
          status: 404,
          detail: 'No job with the provided identifier exists.',
        });
      }

      const data = snapshot.data();
      if (data.userId && data.userId !== req.user.id) {
        throw createProblem({
          type: 'https://docs.image-restoration.ai/problem/job-not-found',
          title: 'Job Not Found',
          status: 404,
          detail: 'No job with the provided identifier exists.',
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      res.write(': connected\n\n');

      const sendUpdate = async (docSnapshot) => {
        if (!docSnapshot.exists) {
          res.write('event: status\n');
          res.write(`data: ${JSON.stringify({ jobId, status: 'not_found' })}\n\n`);
          return;
        }

        const payload = await buildJobResponse({ jobId, data: docSnapshot.data(), req });
        res.write('event: status\n');
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      await sendUpdate(snapshot);

      const unsubscribe = docRef.onSnapshot(
        (docSnapshot) => {
          sendUpdate(docSnapshot).catch((error) => {
            req.clients.logger?.error('[jobs] SSE send failed', { jobId, error: error?.message });
          });
        },
        (error) => {
          res.write('event: error\n');
          res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
          res.end();
        }
      );

      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, SSE_HEARTBEAT_INTERVAL_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      };

      req.on('close', cleanup);
      req.on('end', cleanup);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
