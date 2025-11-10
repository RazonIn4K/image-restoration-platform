import { describe, it, expect } from 'vitest';
import { PromptEnhancerService } from '../src/services/promptEnhancer.js';
import { createTestLogger } from './utils/mocks.js';

const baseDegradation = {
  blur: 0.1,
  noise: 0.1,
  lowLight: 0.1,
  compression: 0.1,
  scratch: 0.1,
  fade: 0.1,
  colorShift: 0.1,
};

describe('PromptEnhancerService', () => {
  it('prioritizes top degradation issues and tailors instructions', async () => {
    const service = new PromptEnhancerService({ logger: createTestLogger() });

    const degradation = {
      ...baseDegradation,
      blur: 0.82,
      noise: 0.81,
      colorShift: 0.76,
      fade: 0.55,
    };

    const enhanced = await service.enhance({
      degradation,
      userPrompt: 'Repair and restore the family portrait',
    });

    expect(enhanced).toContain('reduce severe motion blur');
    expect(enhanced).toContain('aggressively suppress grain');
    expect(enhanced).toContain('correct severe color cast');
    expect(enhanced).toContain('Repair and restore the family portrait');
  });

  it('defaults to subtle enhancements when no major issues detected', async () => {
    const service = new PromptEnhancerService({ logger: createTestLogger() });
    const degradation = { ...baseDegradation };

    const enhanced = await service.enhance({ degradation });

    expect(enhanced).toContain('Quality guidelines');
    expect(enhanced).toContain('subtle enhancements only');
  });

  it('truncates overly long user prompts to stay within token limits', async () => {
    const service = new PromptEnhancerService({ logger: createTestLogger() });
    const degradation = { ...baseDegradation, blur: 0.9 };
    const veryLongPrompt = 'enhance '.repeat(300);

    const enhanced = await service.enhance({ degradation, userPrompt: veryLongPrompt });

    expect(enhanced.length).toBeLessThanOrEqual(1000);
    expect(enhanced).toContain('User request:');
    expect(enhanced.endsWith('...')).toBe(true);
  });
});
