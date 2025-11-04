import { createProblem } from '../utils/problem.js';

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

    if (!req.services?.moderation) {
      return next(new Error('Moderation service is not available.'));
    }

    const context = {
      userId: req.user?.id,
      jobId: req.body?.jobId || null,
      requestId: req.context?.requestId,
    };

    const moderationResult = await req.services.moderation.moderate(req.file.buffer, context);
    req.moderation = moderationResult;

    if (!moderationResult.allowed) {
      return next(
        createProblem({
          type: 'https://docs.image-restoration.ai/problem/moderation-rejected',
          title: 'Content Moderation Rejected Image',
          status: 422,
          detail: moderationResult.rejection?.reason || 'Uploaded content violates our safety policy.',
          extras: {
            categories: moderationResult.rejection?.categories ?? [],
            flags: moderationResult.flags,
          },
        })
      );
    }

    return next();
  } catch (error) {
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
