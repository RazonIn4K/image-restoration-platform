import { trace, SpanStatusCode } from '@opentelemetry/api';

/**
 * Prompt Enhancer Service - Generates optimized Gemini prompts based on degradation analysis
 * 
 * Merges degradation-specific templates with user intent to create effective restoration prompts
 */

const DEGRADATION_TEMPLATES = {
  blur: {
    high: "reduce severe motion blur and sharpen edges while preserving natural detail",
    medium: "reduce motion blur and improve focus clarity",
    low: "slightly enhance sharpness and edge definition"
  },
  noise: {
    high: "aggressively suppress grain and noise while preserving fine detail and texture",
    medium: "reduce noise and grain while maintaining image detail",
    low: "lightly reduce noise without affecting texture"
  },
  lowLight: {
    high: "significantly enhance brightness and recover shadow detail without overexposure",
    medium: "improve brightness and enhance shadow areas",
    low: "slightly brighten dark areas and improve visibility"
  },
  compression: {
    high: "remove severe JPEG artifacts and restore texture quality",
    medium: "reduce compression artifacts and improve image quality",
    low: "minimize minor compression artifacts"
  },
  scratch: {
    high: "remove scratches, blemishes, and physical damage using advanced inpainting",
    medium: "repair visible scratches and minor damage",
    low: "touch up small blemishes and imperfections"
  },
  fade: {
    high: "restore vibrant colors and dramatically improve contrast",
    medium: "enhance color vibrancy and increase contrast",
    low: "slightly boost colors and improve contrast"
  },
  colorShift: {
    high: "correct severe color cast and restore natural white balance",
    medium: "adjust color balance and improve white balance",
    low: "fine-tune color balance for natural appearance"
  }
};

const BASE_INSTRUCTIONS = {
  quality: "Maintain the highest possible image quality and preserve important details",
  naturalness: "Ensure the result looks natural and realistic, avoiding over-processing",
  preservation: "Preserve the original composition, subject matter, and artistic intent"
};

export class PromptEnhancerService {
  constructor({ logger } = {}) {
    this.logger = logger ?? console;
  }

  /**
   * Generate optimized restoration prompt based on degradation analysis and user input
   * @param {Object} degradation - Degradation analysis from ClassifierService
   * @param {string} userPrompt - Optional custom user prompt
   * @param {Object} options - Additional options for prompt generation
   * @returns {Promise<string>} Enhanced restoration prompt
   */
  async enhance({ degradation, userPrompt, options = {} }) {
    const tracer = trace.getTracer('prompt-enhancer');
    const span = tracer.startSpan('promptEnhancer.enhance', {
      attributes: {
        'prompt.has_user_input': !!userPrompt,
        'prompt.user_length': userPrompt?.length || 0
      }
    });

    try {
      // Identify top degradation issues (confidence > 0.3)
      const issues = this._identifyTopIssues(degradation);
      
      span.setAttributes({
        'prompt.issue_count': issues.length,
        'prompt.top_issues': issues.map(i => `${i.type}:${i.severity}`).join(',')
      });

      // Generate degradation-specific instructions
      const degradationInstructions = this._generateDegradationInstructions(issues);
      
      // Build the complete prompt
      const enhancedPrompt = this._buildPrompt({
        userPrompt,
        degradationInstructions,
        issues,
        options
      });

      span.setAttributes({
        'prompt.final_length': enhancedPrompt.length,
        'prompt.instruction_count': degradationInstructions.length
      });

      this.logger.debug('[prompt-enhancer] Generated enhanced prompt', {
        issues: issues.map(i => ({ type: i.type, severity: i.severity, confidence: i.confidence.toFixed(2) })),
        userPrompt: userPrompt ? `"${userPrompt.substring(0, 50)}..."` : null,
        promptLength: enhancedPrompt.length
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return enhancedPrompt;

    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      this.logger.error('[prompt-enhancer] Enhancement failed', { error: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Identify top degradation issues that need addressing
   */
  _identifyTopIssues(degradation) {
    const threshold = 0.3;
    const issues = [];

    for (const [type, confidence] of Object.entries(degradation)) {
      if (confidence > threshold) {
        const severity = this._determineSeverity(confidence);
        issues.push({ type, confidence, severity });
      }
    }

    // Sort by confidence (highest first) and limit to top 3
    return issues
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }

  /**
   * Determine severity level based on confidence score
   */
  _determineSeverity(confidence) {
    if (confidence >= 0.7) return 'high';
    if (confidence >= 0.5) return 'medium';
    return 'low';
  }

  /**
   * Generate specific instructions for each degradation type
   */
  _generateDegradationInstructions(issues) {
    return issues.map(issue => {
      const template = DEGRADATION_TEMPLATES[issue.type];
      if (!template) {
        this.logger.warn(`[prompt-enhancer] No template for degradation type: ${issue.type}`);
        return `address ${issue.type} issues`;
      }
      
      return template[issue.severity] || template.medium;
    });
  }

  /**
   * Build the complete restoration prompt
   */
  _buildPrompt({ userPrompt, degradationInstructions, issues, options }) {
    const parts = [];

    // Start with user intent if provided
    if (userPrompt && userPrompt.trim()) {
      parts.push(`User request: ${userPrompt.trim()}.`);
    }

    // Add technical restoration instructions
    if (degradationInstructions.length > 0) {
      const technicalInstructions = degradationInstructions.join(', ');
      parts.push(`Technical restoration: ${technicalInstructions}.`);
    }

    // Add base quality instructions
    const qualityInstructions = [
      BASE_INSTRUCTIONS.quality,
      BASE_INSTRUCTIONS.naturalness,
      BASE_INSTRUCTIONS.preservation
    ].join(', ');
    
    parts.push(`Quality guidelines: ${qualityInstructions}.`);

    // Add specific guidance based on issue severity
    if (issues.some(i => i.severity === 'high')) {
      parts.push("This image requires significant restoration work - apply corrections carefully to avoid artifacts.");
    } else if (issues.length === 0) {
      parts.push("This image appears to be in good condition - apply subtle enhancements only.");
    }

    // Combine all parts
    let prompt = parts.join(' ');

    // Ensure prompt isn't too long (Gemini has token limits)
    if (prompt.length > 1000) {
      prompt = prompt.substring(0, 950) + '...';
      this.logger.warn('[prompt-enhancer] Prompt truncated due to length', { originalLength: parts.join(' ').length });
    }

    return prompt;
  }

  /**
   * Get available degradation templates for reference
   */
  static getDegradationTemplates() {
    return JSON.parse(JSON.stringify(DEGRADATION_TEMPLATES));
  }

  /**
   * Validate degradation analysis object
   */
  static validateDegradation(degradation) {
    const requiredTypes = ['blur', 'noise', 'lowLight', 'compression', 'scratch', 'fade', 'colorShift'];
    
    for (const type of requiredTypes) {
      if (!(type in degradation)) {
        throw new Error(`Missing degradation type: ${type}`);
      }
      
      const value = degradation[type];
      if (typeof value !== 'number' || value < 0 || value > 1) {
        throw new Error(`Invalid degradation value for ${type}: must be number between 0 and 1`);
      }
    }
    
    return true;
  }
}

export function createPromptEnhancerService(options = {}) {
  return new PromptEnhancerService(options);
}