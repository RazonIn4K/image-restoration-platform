import { Router } from 'express';

const router = Router();

// Placeholder endpoint for single-image restoration
router.post('/single', (_req, res) => {
  res.status(501).json({ message: 'Single-image restoration not implemented yet.' });
});

// Placeholder endpoint for multi-image fusion
router.post('/multi', (_req, res) => {
  res.status(501).json({ message: 'Multi-image fusion not implemented yet.' });
});

export default router;
