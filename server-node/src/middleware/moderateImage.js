import { createProblem } from '../utils/problem.js';

export async function moderateBuffer(moderationService, buffer, context) {
  if (!moderationService) {
    throw new Error('Moderation service is not available.');
  }

  const result = await moderationService.moderate(buffer, context);
  if (!result.allowed) {
    throw createProblem({
      type: 'https://docs.image-restoration.ai/problem/moderation-rejected',
      title: 'Content Moderation Rejected Image',
      status: 422,
      detail: result.rejection?.reason || 'Uploaded content violates our safety policy.',
      extras: {
        categories: result.rejection?.categories ?? [],
        flags: result.flags,
      },
    });
  }
  return result;
}

export async function moderateImage(req, _res, next) {
  try {
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

    const context = {
      userId: req.user?.id,
      jobId: req.body?.jobId || null,
      requestId: req.context?.requestId,
    };

    const moderationResult = await moderateBuffer(req.services?.moderation, req.file.buffer, context);
    req.moderation = moderationResult;

    return next();
  } catch (error) {
    if (error?.status && error?.title) {
      return next(error);
    }

    return next(
      createProblem({
        type: 'https://docs.image-restoration.ai/problem/moderation-failed',
        title: 'Content Moderation Failed',
        status: 500,
        detail: error?.message ?? 'Unable to moderate the uploaded image.',
      })
    );
  }
}
