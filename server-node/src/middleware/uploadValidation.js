import path from 'path';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { createProblem } from '../utils/problem.js';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ACCEPTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const RETRY_AFTER_SECONDS = 60;

function getFileExtension(filename) {
  if (!filename) return '';
  return path.extname(filename.toLowerCase());
}

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
  fileFilter(_req, file, cb) {
    const extension = getFileExtension(file.originalname);
    if (!ACCEPTED_EXTENSIONS.has(extension)) {
      return cb(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/unsupported-file-extension',
          title: 'Unsupported File Extension',
          status: 415,
          detail: 'Only .jpg, .jpeg, .png, or .webp files are allowed.',
        })
      );
    }
    cb(null, true);
  },
});

export function handleUpload(fieldName = 'image') {
  const uploadSingle = upload.single(fieldName);

  return (req, res, next) => {
    uploadSingle(req, res, (err) => {
      if (!err) {
        if (!req.file) {
          return next(
            createProblem({
              type: 'https://docs.image-restoration.ai/problem/image-missing',
              title: 'Image File Required',
              status: 400,
              detail: 'An image file must be provided in the request.',
            })
          );
        }
        return next();
      }

      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.set('Retry-After', RETRY_AFTER_SECONDS);
        return next(
          createProblem({
            type: 'https://docs.image-restoration.ai/problem/file-too-large',
            title: 'File Too Large',
            status: 413,
            detail: `The uploaded file exceeds the maximum allowed size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.`,
          })
        );
      }

      if (err instanceof Error && err.name === 'Problem') {
        return next(err);
      }

      return next(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/upload-failed',
          title: 'Upload Failed',
          status: 400,
          detail: err?.message ?? 'Unable to process the uploaded file.',
        })
      );
    });
  };
}

export async function validateUploadedImage(req, _res, next) {
  try {
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !ACCEPTED_MIME_TYPES.has(detected.mime)) {
      return next(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/unsupported-media-type',
          title: 'Unsupported Media Type',
          status: 415,
          detail: 'Only JPEG, PNG, or WebP images are supported.',
        })
      );
    }

    req.file.detectedMime = detected.mime;
    req.file.detectedExt = detected.ext;

    return next();
  } catch (error) {
    return next(
      createProblem({
        type: 'https://docs.image-restoration.ai/problem/upload-validation-failed',
        title: 'Upload Validation Failed',
        status: 400,
        detail: error?.message ?? 'Unable to validate the uploaded image.',
      })
    );
  }
}
