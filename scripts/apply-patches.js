#!/usr/bin/env node
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

try {
  require.resolve('patch-package');
} catch (err) {
  console.log('patch-package not installed, skipping patches.');
  process.exit(0);
}

try {
  execSync('patch-package', { stdio: 'inherit' });
} catch (err) {
  console.error('Failed to apply patches:', err);
}
