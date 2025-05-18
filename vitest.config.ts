import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true, // To use describe, it, etc. without importing them in every file
    environment: 'node', // Use Node environment to avoid requiring jsdom
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'], // Common reporters
      reportsDirectory: './coverage',
      include: [
        'src/**/*.ts'
      ],
      exclude: [
        'src/types.ts', // Type definitions are usually not part of coverage metrics
        '**/node_modules/**',
        '**/dist/**',
        '**/test/**',
        '**/*.test.ts',
        'ref/**',       // Exclude the entire ref directory
        'vitest.config.ts' // Exclude the config file itself
      ],
      all: true, // Show coverage for all included files, even if no tests cover them
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
}); 