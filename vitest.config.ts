import { defineConfig } from 'vitest/config';

const isIntegrationTest = process.env.RUNNING_INTEGRATION_TESTS === 'true';

export default defineConfig({
  test: {
    globals: true, // To use describe, it, etc. without importing them in every file
    environment: 'jsdom', // Use JSDOM environment to provide DOM APIs like document
    include: isIntegrationTest
      ? ['test/integration/**/*.test.ts'] // 統合テスト実行時
      : [ // 通常時
          'test/**/*.test.ts',
          '!test/integration/**/*.test.ts',
        ],
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
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
}); 
