#!/usr/bin/env node
import { assertRequiredSecrets, listRequiredSecrets } from '../src/config/secrets.js';

const success = assertRequiredSecrets({ exitOnError: false });

if (success) {
  console.log('[config] All required secrets are present.');
  process.exit(0);
}

const expected = listRequiredSecrets().join(', ');
console.error(`[config] Required secrets: ${expected}`);
process.exit(1);
