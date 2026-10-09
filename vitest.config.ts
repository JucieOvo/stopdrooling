import { defineConfig } from 'vitest/config'

// Standalone config so this bundle's tests run outside the monorepo's projects.
export default defineConfig({
  test: { include: ['tests/**/*.spec.ts'], environment: 'node' },
})
