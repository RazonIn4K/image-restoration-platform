import { describe, it, expect, vi } from 'vitest';
import { RestoratorService } from '../src/services/restorator.js';
import { createCleanImage } from './utils/imageFixtures.js';
import { createTestLogger } from './utils/mocks.js';

describe('RestoratorService', () => {
  const userContext = { userId: 'user-123' };
  const degradation = {
    blur: 0.6,
    noise: 0.4,
    lowLight: 0.2,
    compression: 0.3,
    scratch: 0.1,
    fade: 0.2,
    colorShift: 0.1,
  };

  it('runs the full restoration workflow and returns metadata', async () => {
    const geminiClient = {
      restoreImage: vi.fn().mockResolvedValue({
        base64Image: 'ZmFrZS1kYXRh',
        metadata: {
          providerRequestId: 'req-123',
          estimatedCostUsd: 0.12,
          billedTokens: 512,
        },
      }),
    };

    const service = new RestoratorService({ geminiClient, logger: createTestLogger() });
    service.classifier = { analyze: vi.fn().mockResolvedValue(degradation) };
    service.promptEnhancer = { enhance: vi.fn().mockResolvedValue('enhanced prompt') };

    const imageBuffer = await createCleanImage();
    const result = await service.restore({
      imageBuffer,
      userPrompt: 'touch up blemishes',
      userContext,
    });

    expect(service.classifier.analyze).toHaveBeenCalledWith(imageBuffer);
    expect(service.promptEnhancer.enhance).toHaveBeenCalledWith({
      degradation,
      userPrompt: 'touch up blemishes',
      options: {},
    });
    expect(geminiClient.restoreImage).toHaveBeenCalledWith({
      prompt: 'enhanced prompt',
      images: [imageBuffer],
      userContext,
    });

    expect(result.success).toBe(true);
    expect(result.metadata.providerRequestId).toBe('req-123');
    expect(result.metadata.classificationIssues.length).toBeGreaterThanOrEqual(1);
    expect(result.timings).toHaveProperty('classify_ms');
    expect(result.timings.classify_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns structured errors when restoration fails', async () => {
    const geminiClient = {
      restoreImage: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };

    const service = new RestoratorService({ geminiClient, logger: createTestLogger() });
    service.classifier = { analyze: vi.fn().mockResolvedValue(degradation) };
    service.promptEnhancer = { enhance: vi.fn().mockResolvedValue('prompt') };

    const imageBuffer = await createCleanImage();
    const result = await service.restore({ imageBuffer, userContext });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      message: 'provider unavailable',
      code: 'RESTORATION_FAILED',
    });
    expect(result.metadata.failureStage).toBe('CLASSIFICATION');
  });
});
