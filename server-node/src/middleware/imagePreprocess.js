import sharp from 'sharp';
import { createProblem } from '../utils/problem.js';

const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 85;

function needsResize(width, height) {
  if (!width || !height) return false;
  return width > MAX_DIMENSION || height > MAX_DIMENSION;
}

function calculateResizeDimensions(width, height) {
  if (!width || !height) return {};
  const scale = MAX_DIMENSION / Math.max(width, height);
  if (scale >= 1) {
    return { width, height };
  }
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

export async function preprocessImage(req, _res, next) {
  if (!req.file?.buffer) {
    return next(
      createProblem({
        type: 'https://docs.image-restoration.ai/problem/image-missing',
        title: 'Image File Required',
        status: 400,
        detail: 'An image file must be provided in the request.',
      })
    );
  }

  try {
    const operations = [];

    const sourceBuffer = req.file.buffer;
    const sourceMetadata = await sharp(sourceBuffer, { failOnError: false }).metadata();

    let pipeline = sharp(sourceBuffer, { failOnError: false }).rotate();
    operations.push('auto_orient');

    const { width, height } = sourceMetadata;
    if (needsResize(width, height)) {
      const dimensions = calculateResizeDimensions(width, height);
      pipeline = pipeline.resize({
        width: dimensions.width,
        height: dimensions.height,
        fit: 'inside',
        withoutEnlargement: true,
      });
      operations.push(`resize_${dimensions.width}x${dimensions.height}`);
    }

    pipeline = pipeline
      .jpeg({
        quality: JPEG_QUALITY,
        chromaSubsampling: '4:4:4',
        mozjpeg: true,
      })
      .withMetadata({ icc: 'sRGB' });
    operations.push(`compress_jpeg_q${JPEG_QUALITY}`);
    operations.push('attach_sRGB_icc');

    const processedBuffer = await pipeline.toBuffer();
    const processedMetadata = await sharp(processedBuffer).metadata();

    req.file.originalBuffer = sourceBuffer;
    req.file.originalMetadata = sourceMetadata;
    req.file.buffer = processedBuffer;
    req.file.processedMetadata = processedMetadata;
    req.file.mimetype = 'image/jpeg';
    req.file.detectedMime = 'image/jpeg';
    req.file.detectedExt = 'jpg';
    req.file.size = processedBuffer.length;
    req.file.preprocessOperations = operations;

    return next();
  } catch (error) {
    return next(
      createProblem({
        type: 'https://docs.image-restoration.ai/problem/preprocess-failed',
        title: 'Image Preprocessing Failed',
        status: 422,
        detail: error?.message ?? 'Unable to preprocess the uploaded image.',
      })
    );
  }
}
