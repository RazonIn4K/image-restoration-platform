import express from 'express';
import cors from 'cors';

import { assertRequiredSecrets } from './config/secrets.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { requestContext } from './middleware/requestContext.js';
import { firebaseAuth } from './middleware/firebaseAuth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { notFoundHandler } from './middleware/notFound.js';
import { errorHandler } from './utils/problem.js';
import { attachClients } from './middleware/clients.js';
import { getClients } from './context/clients.js';
import { attachServices } from './context/services.js';
import { createJobsRouter } from './routes/jobsRouter.js';

assertRequiredSecrets();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(requestContext());
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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'node', ts: new Date().toISOString() });
});

const apiRouter = express.Router();

apiRouter.use(firebaseAuth());
const sharedClients = getClients();
apiRouter.use(rateLimitMiddleware({ store: sharedClients.redis }));

apiRouter.use(createJobsRouter({ redisStore: sharedClients.redis }));

app.use('/v1', apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[api-node] listening on ${port}`));
