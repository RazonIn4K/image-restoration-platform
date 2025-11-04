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

export async function preprocessBuffer(buffer) {
  const operations = [];

  const sourceMetadata = await sharp(buffer, { failOnError: false }).metadata();

  let pipeline = sharp(buffer, { failOnError: false }).rotate();
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

  return {
    buffer: processedBuffer,
    processedMetadata,
    originalMetadata: sourceMetadata,
    operations,
    size: processedBuffer.length,
    mime: 'image/jpeg',
    extension: 'jpg',
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
    const result = await preprocessBuffer(req.file.buffer);

    req.file.originalBuffer = req.file.buffer;
    req.file.originalMetadata = result.originalMetadata;
    req.file.buffer = result.buffer;
    req.file.processedMetadata = result.processedMetadata;
    req.file.mimetype = result.mime;
    req.file.detectedMime = result.mime;
    req.file.detectedExt = result.extension;
    req.file.size = result.size;
    req.file.preprocessOperations = result.operations;

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
