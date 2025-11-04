import express from 'express';
import cors from 'cors';

import { assertRequiredSecrets } from './config/secrets.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { requestContext } from './middleware/requestContext.js';
import { requestTiming } from './middleware/requestTiming.js';
import { firebaseAuth } from './middleware/firebaseAuth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { notFoundHandler } from './middleware/notFound.js';
import { createProblem, errorHandler } from './utils/problem.js';
import { attachClients } from './middleware/clients.js';
import { getClients } from './context/clients.js';
import { attachServices } from './context/services.js';
import { handleUpload, validateUploadedImage } from './middleware/uploadValidation.js';
import { preprocessImage } from './middleware/imagePreprocess.js';
import { moderateImage } from './middleware/moderateImage.js';
import { createHealthRouter } from './routes/healthRouter.js';

assertRequiredSecrets();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(requestContext());
app.use(requestTiming());
app.use(attachClients());
app.use(attachServices());
for (const middleware of securityHeaders()) {
  app.use(middleware);
}

app.use(
  cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/health', createHealthRouter({ clients: getClients() }));

const apiRouter = express.Router();

apiRouter.use(firebaseAuth());
const sharedClients = getClients();
apiRouter.use(rateLimitMiddleware({ store: sharedClients.redis }));

apiRouter.post(
  '/jobs',
  idempotencyMiddleware({ store: sharedClients.redis }),
  handleUpload('image'),
  validateUploadedImage,
  preprocessImage,
  moderateImage,
  (_req, _res, next) =>
  next(
    createProblem({
      type: 'https://docs.image-restoration.ai/problem/not-implemented',
      title: 'Not Implemented',
      status: 501,
      detail: 'Job submission endpoint is not yet implemented.',
    })
  )
);

app.use('/v1', apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[api-node] listening on ${port}`));
