import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateUploadedImage } from '../src/middleware/uploadValidation.js';
import { preprocessImage } from '../src/middleware/imagePreprocess.js';
import { moderateImage } from '../src/middleware/moderateImage.js';
import { createCleanImage } from './utils/imageFixtures.js';

function createReq({ fileBuffer = null, services = {}, body = {}, user = { id: 'user-1' }, context = { requestId: 'req-1' } } = {}) {
  const req = { file: fileBuffer ? { buffer: fileBuffer, originalname: 'sample.jpg' } : null, services, body, user, context };
  return req;
}

function createNext() {
  const next = vi.fn((err) => err);
  return next;
}

describe('middleware', () => {
  let next;

  beforeEach(() => {
    next = createNext();
  });

  describe('validateUploadedImage', () => {
    it('adds detected mime information for valid images', async () => {
      const buffer = await createCleanImage();
      const req = createReq({ fileBuffer: buffer });

      await validateUploadedImage(req, {}, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.file.detectedMime).toBe('image/jpeg');
      expect(req.file.detectedExt).toBe('jpg');
    });

    it('rejects unsupported file buffers', async () => {
      const req = createReq({ fileBuffer: Buffer.from('not-an-image') });

      await validateUploadedImage(req, {}, next);

      expect(next).toHaveBeenCalledTimes(1);
      const problem = next.mock.calls[0][0];
      expect(problem.status).toBe(415);
      expect(problem.title).toMatch(/Unsupported Media Type/i);
    });
  });

  describe('preprocessImage', () => {
    it('auto-orients, compresses, and records operations', async () => {
      const buffer = await createCleanImage();
      const req = createReq({ fileBuffer: buffer });

      await preprocessImage(req, {}, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.file.originalBuffer).toBeDefined();
      expect(req.file.preprocessOperations).toContain('auto_orient');
      expect(req.file.preprocessOperations.some((op) => op.startsWith('compress_jpeg'))).toBe(true);
      expect(req.file.mimetype).toBe('image/jpeg');
      expect(req.file.buffer.equals(req.file.originalBuffer)).toBe(false);
    });

    it('uses original buffer when missing file', async () => {
      const req = createReq();
      await preprocessImage(req, {}, next);

      const problem = next.mock.calls[0][0];
      expect(problem.status).toBe(400);
      expect(problem.title).toMatch(/Image File Required/);
    });
  });

  describe('moderateImage', () => {
    it('allows request when moderation approves', async () => {
      const buffer = await createCleanImage();
      const moderationService = {
        moderate: vi.fn().mockResolvedValue({ allowed: true, flags: {} }),
      };
      const req = createReq({ fileBuffer: buffer, services: { moderation: moderationService } });

      await moderateImage(req, {}, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.moderation.allowed).toBe(true);
      expect(moderationService.moderate).toHaveBeenCalled();
    });

    it('rejects when moderation flags unsafe content', async () => {
      const buffer = await createCleanImage();
      const moderationService = {
        moderate: vi.fn().mockResolvedValue({
          allowed: false,
          rejection: { reason: 'unsafe', categories: ['racy'] },
          flags: { racy: 'LIKELY' },
        }),
      };
      const req = createReq({ fileBuffer: buffer, services: { moderation: moderationService } });

      await moderateImage(req, {}, next);

      const problem = next.mock.calls[0][0];
      expect(problem.status).toBe(422);
      expect(problem.extras.categories).toContain('racy');
    });

    it('fails closed when moderation service throws', async () => {
      const buffer = await createCleanImage();
      const moderationService = {
        moderate: vi.fn().mockRejectedValue(new Error('vision down')),
      };
      const req = createReq({ fileBuffer: buffer, services: { moderation: moderationService } });

      await moderateImage(req, {}, next);

      const problem = next.mock.calls[0][0];
      expect(problem.status).toBe(500);
      expect(problem.title).toMatch(/Content Moderation Failed/);
    });

    it('errors when moderation service missing', async () => {
      const buffer = await createCleanImage();
      const req = createReq({ fileBuffer: buffer, services: {} });

      await moderateImage(req, {}, next);

      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/Moderation service is not available/);
    });
  });
});
