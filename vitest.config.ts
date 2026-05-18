import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    environment: 'node',
    // Resolve .js → .ts for Node16 ESM source imports
    // Provide a minimal vscode stub so contextGuard.ts can be imported in tests
    alias: [
      { find: /^(\.\.?\/.*?)\.js$/, replacement: '$1' },
      { find: 'vscode', replacement: path.resolve(__dirname, 'src/test/__mocks__/vscode.ts') },
    ],
  },
});
