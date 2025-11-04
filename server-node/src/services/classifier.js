import { trace, SpanStatusCode } from '@opentelemetry/api';
import sharp from 'sharp';

/**
 * Classifier Service - Analyzes image degradation types and confidence scores
 * 
 * Supports multiple simultaneous degradation types:
 * - blur: Motion blur, out-of-focus
 * - noise: Grain, digital noise
 * - lowLight: Underexposed, shadow detail loss
 * - compression: JPEG artifacts, quality loss
 * - scratch: Physical damage, blemishes
 * - fade: Color loss, contrast reduction
 * - colorShift: White balance issues, color cast
 */

const DEGRADATION_TYPES = {
  blur: 'Motion blur or out-of-focus areas',
  noise: 'Grain and digital noise',
  lowLight: 'Underexposed or shadow detail loss',
  compression: 'JPEG artifacts and quality loss',
  scratch: 'Physical damage and blemishes',
  fade: 'Color loss and contrast reduction',
  colorShift: 'White balance and color cast issues'
};

let blockinessWarningLogged = false;
let scratchWarningLogged = false;

export class ClassifierService {
  constructor({ logger } = {}) {
    this.logger = logger ?? console;
  }

  /**
   * Analyze image degradation types and return confidence scores
   * @param {Buffer} imageBuffer - Input image buffer
   * @returns {Promise<Object>} Degradation analysis with confidence scores (0.0-1.0)
   */
  async analyze(imageBuffer) {
    const tracer = trace.getTracer('classifier');
    const span = tracer.startSpan('classifier.analyze', {
      attributes: {
        'image.size_bytes': imageBuffer.length,
        'classifier.version': '1.0.0'
      }
    });

    try {
      // Get image metadata and statistics
      const metadata = await sharp(imageBuffer).metadata();
      const stats = await sharp(imageBuffer).stats();
      
      span.setAttributes({
        'image.width': metadata.width,
        'image.height': metadata.height,
        'image.format': metadata.format,
        'image.channels': metadata.channels
      });

      // Analyze different degradation types
      const analysis = {
        blur: await this._analyzeBlur(imageBuffer, metadata, stats),
        noise: await this._analyzeNoise(imageBuffer, metadata, stats),
        lowLight: await this._analyzeLowLight(imageBuffer, metadata, stats),
        compression: await this._analyzeCompression(imageBuffer, metadata, stats),
        scratch: await this._analyzeScratch(imageBuffer, metadata, stats),
        fade: await this._analyzeFade(imageBuffer, metadata, stats),
        colorShift: await this._analyzeColorShift(imageBuffer, metadata, stats)
      };

      // Log analysis results
      const topIssues = Object.entries(analysis)
        .filter(([_, score]) => score > 0.3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      span.setAttributes({
        'classifier.top_issues': topIssues.map(([type, score]) => `${type}:${score.toFixed(2)}`).join(','),
        'classifier.issue_count': topIssues.length
      });

      this.logger.debug('[classifier] Analysis complete', {
        topIssues: topIssues.map(([type, score]) => ({ type, score: score.toFixed(2) })),
        imageSize: `${metadata.width}x${metadata.height}`
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return analysis;

    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      this.logger.error('[classifier] Analysis failed', { error: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Analyze motion blur and focus issues
   */
  async _analyzeBlur(imageBuffer, metadata, stats) {
    try {
      // Convert to grayscale and apply Laplacian edge detection
      const edges = await sharp(imageBuffer)
        .grayscale()
        .convolve({
          width: 3,
          height: 3,
          kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1]
        })
        .raw()
        .toBuffer();

      // Calculate variance of edge response (lower = more blur)
      const edgeVariance = this._calculateVariance(edges);
      const normalizedVariance = Math.min(edgeVariance / 1000, 1.0);
      
      // Invert: high variance = sharp, low variance = blurry
      return Math.max(0, 1.0 - normalizedVariance);
    } catch (error) {
      this.logger.warn('[classifier] Blur analysis failed, using fallback', { error: error.message });
      return 0.1; // Conservative fallback
    }
  }

  /**
   * Analyze noise and grain
   */
  async _analyzeNoise(imageBuffer, metadata, stats) {
    try {
      // Apply high-pass filter to detect noise
      const highPass = await sharp(imageBuffer)
        .grayscale()
        .convolve({
          width: 3,
          height: 3,
          kernel: [-1, -1, -1, -1, 9, -1, -1, -1, -1]
        })
        .raw()
        .toBuffer();

      const noiseLevel = this._calculateStandardDeviation(highPass);
      return Math.min(noiseLevel / 50, 1.0);
    } catch (error) {
      this.logger.warn('[classifier] Noise analysis failed, using fallback', { error: error.message });
      return 0.1;
    }
  }

  /**
   * Analyze low light and underexposure
   */
  async _analyzeLowLight(imageBuffer, metadata, stats) {
    try {
      // Check overall brightness and shadow detail
      const meanBrightness = stats.channels.reduce((sum, ch) => sum + ch.mean, 0) / stats.channels.length;
      const normalizedBrightness = meanBrightness / 255;
      
      // Low brightness indicates potential low-light issues
      if (normalizedBrightness < 0.3) {
        return Math.min((0.3 - normalizedBrightness) * 2, 1.0);
      }
      
      return 0.0;
    } catch (error) {
      this.logger.warn('[classifier] Low-light analysis failed, using fallback', { error: error.message });
      return 0.1;
    }
  }

  /**
   * Analyze JPEG compression artifacts
   */
  async _analyzeCompression(imageBuffer, metadata, stats) {
    try {
      // JPEG artifacts are more likely in JPEG images with low quality
      if (metadata.format !== 'jpeg') {
        return 0.0;
      }

      // Detect blocking artifacts using DCT-like analysis
      const blockiness = await this._detectBlockiness(imageBuffer);
      return Math.min(blockiness, 1.0);
    } catch (error) {
      this.logger.warn('[classifier] Compression analysis failed, using fallback', { error: error.message });
      return metadata.format === 'jpeg' ? 0.2 : 0.0;
    }
  }

  /**
   * Analyze scratches and physical damage
   */
  async _analyzeScratch(imageBuffer, metadata, stats) {
    try {
      // Look for thin, high-contrast lines that could be scratches
      const edges = await sharp(imageBuffer)
        .grayscale()
        .convolve({
          width: 3,
          height: 3,
          kernel: [0, -1, 0, -1, 4, -1, 0, -1, 0]
        })
        .raw()
        .toBuffer();

      const scratchIndicator = this._detectLinearFeatures(edges, metadata.width, metadata.height);
      return Math.min(scratchIndicator, 1.0);
    } catch (error) {
      this.logger.warn('[classifier] Scratch analysis failed, using fallback', { error: error.message });
      return 0.05;
    }
  }

  /**
   * Analyze color fading and contrast loss
   */
  async _analyzeFade(imageBuffer, metadata, stats) {
    try {
      // Check color saturation and contrast
      const colorfulness = this._calculateColorfulness(stats);
      const contrast = this._calculateContrast(stats);
      
      // Low colorfulness and contrast indicate fading
      const fadeScore = (1.0 - colorfulness) * 0.6 + (1.0 - contrast) * 0.4;
      return Math.min(fadeScore, 1.0);
    } catch (error) {
      this.logger.warn('[classifier] Fade analysis failed, using fallback', { error: error.message });
      return 0.1;
    }
  }

  /**
   * Analyze color cast and white balance issues
   */
  async _analyzeColorShift(imageBuffer, metadata, stats) {
    try {
      if (stats.channels.length < 3) {
        return 0.0; // Grayscale images don't have color cast
      }

      // Calculate color balance between channels
      const [r, g, b] = stats.channels.slice(0, 3);
      const avgMean = (r.mean + g.mean + b.mean) / 3;
      
      const rDeviation = Math.abs(r.mean - avgMean) / avgMean;
      const gDeviation = Math.abs(g.mean - avgMean) / avgMean;
      const bDeviation = Math.abs(b.mean - avgMean) / avgMean;
      
      const maxDeviation = Math.max(rDeviation, gDeviation, bDeviation);
      return Math.min(maxDeviation * 2, 1.0);
    } catch (error) {
      this.logger.warn('[classifier] Color shift analysis failed, using fallback', { error: error.message });
      return 0.1;
    }
  }

  // Helper methods for statistical analysis

  _calculateVariance(buffer) {
    const mean = buffer.reduce((sum, val) => sum + val, 0) / buffer.length;
    const variance = buffer.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / buffer.length;
    return variance;
  }

  _calculateStandardDeviation(buffer) {
    return Math.sqrt(this._calculateVariance(buffer));
  }

  _calculateColorfulness(stats) {
    if (stats.channels.length < 3) return 0.5;
    
    const [r, g, b] = stats.channels.slice(0, 3);
    const saturation = Math.sqrt(
      Math.pow(r.stdev, 2) + Math.pow(g.stdev, 2) + Math.pow(b.stdev, 2)
    ) / 255;
    
    return Math.min(saturation, 1.0);
  }

  _calculateContrast(stats) {
    const avgStdev = stats.channels.reduce((sum, ch) => sum + ch.stdev, 0) / stats.channels.length;
    return Math.min(avgStdev / 64, 1.0); // Normalize to 0-1 range
  }

  async _detectBlockiness(imageBuffer) {
    if (!blockinessWarningLogged) {
      this.logger.warn('[classifier] Blockiness detection is using a simplified heuristic. Enhance with DCT-based analysis for production accuracy.');
      blockinessWarningLogged = true;
    }

    // Very lightweight heuristic: compare variance before/after slight blur
    try {
      const original = await sharp(imageBuffer).raw().toBuffer({ resolveWithObject: true });
      const blurred = await sharp(imageBuffer).blur(1).raw().toBuffer({ resolveWithObject: true });

      const originalVariance = this._calculateVariance(original.data);
      const blurredVariance = this._calculateVariance(blurred.data);
      const varianceDelta = Math.max(0, originalVariance - blurredVariance);

      return Math.min(varianceDelta / 500, 1.0);
    } catch (error) {
      this.logger.debug('[classifier] Blockiness heuristic failed; returning fallback confidence', { error: error.message });
      return 0.2;
    }
  }

  _detectLinearFeatures(edgeBuffer, width, height) {
    if (!scratchWarningLogged) {
      this.logger.warn('[classifier] Scratch detection is using a simplified heuristic. Integrate Hough transforms for better accuracy.');
      scratchWarningLogged = true;
    }

    let verticalCount = 0;
    let horizontalCount = 0;
    const threshold = 200;

    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const idx = y * width + x;
        const value = edgeBuffer[idx];
        if (value > threshold) {
          if (x + 1 < width) {
            verticalCount += edgeBuffer[idx + 1] > threshold ? 1 : 0;
          }
          if (y + 1 < height) {
            horizontalCount += edgeBuffer[idx + width] > threshold ? 1 : 0;
          }
        }
      }
    }

    const total = verticalCount + horizontalCount;
    return Math.min(total / 1000, 1.0);
  }

  /**
   * Get human-readable description of degradation types
   */
  static getDegradationTypes() {
    return { ...DEGRADATION_TYPES };
  }
}

export function createClassifierService(options = {}) {
  return new ClassifierService(options);
}
