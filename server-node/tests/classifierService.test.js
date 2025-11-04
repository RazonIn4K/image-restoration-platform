import { describe, it, expect, beforeEach } from 'vitest';
import { ClassifierService } from '../src/services/classifier.js';
import {
  createBlurredImage,
  createNoisyImage,
  createDarkImage,
  createColorShiftedImage,
  createCleanImage,
} from './utils/imageFixtures.js';
import { createTestLogger } from './utils/mocks.js';

describe('ClassifierService', () => {
  let service;

  beforeEach(() => {
    service = new ClassifierService({ logger: createTestLogger() });
  });

  it('detects motion blur in blurred images', async () => {
    const buffer = await createBlurredImage();
    const result = await service.analyze(buffer);

    expect(result.blur).toBeGreaterThan(0.2);
    expect(result.noise).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('colorShift');
  });

  it('detects strong noise levels', async () => {
    const buffer = await createNoisyImage();
    const result = await service.analyze(buffer);

    expect(result.noise).toBeGreaterThan(0.3);
  });

  it('detects low light conditions', async () => {
    const buffer = await createDarkImage();
    const result = await service.analyze(buffer);

    expect(result.lowLight).toBeGreaterThan(0.3);
  });

  it('detects color cast shifts', async () => {
    const buffer = await createColorShiftedImage();
    const result = await service.analyze(buffer);

    expect(result.colorShift).toBeGreaterThan(0.25);
  });

  it('returns normalized metrics for clean images', async () => {
    const buffer = await createCleanImage();
    const result = await service.analyze(buffer);

    for (const value of Object.values(result)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
