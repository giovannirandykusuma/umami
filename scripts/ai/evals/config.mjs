// Test dependencies may be shared by a worktree without changing package configuration.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.env.AI_EVAL_DEPENDENCIES || '.', 'package.json'));
export default {
  resolve: {
    alias: {
      zod: require.resolve('zod'),
      vitest: require.resolve('vitest').replace(/index\.cjs$/, 'dist/index.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/lib/ai/guidance.test.ts', 'scripts/ai/evals/*.test.ts'],
  },
};
