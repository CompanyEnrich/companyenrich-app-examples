import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Handler tests run in Node; UI test files opt into jsdom with a
    // `// @vitest-environment jsdom` comment on their first line.
    environment: 'node',
  },
});
