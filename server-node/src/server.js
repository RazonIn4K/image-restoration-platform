import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import restoreRoutes from './routes/restore.js';

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'node', ts: new Date().toISOString() });
});

app.use('/restore', restoreRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[api-node] listening on ${port}`));
