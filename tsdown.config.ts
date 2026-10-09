import { defineConfig } from 'tsdown'

// Self-contained transpile of src/ to lib/: no project references, no type
// check. Host-shared @deepseek-ai/* packages stay external peers.
export default defineConfig({
  entry: {
    index: './src/reasoning-reverse-match.ts',
    matcher: './src/matcher.ts',
    rewrite: './src/rewrite.ts',
    paragraph: './src/paragraph.ts',
    phrases: './src/phrases.ts',
  },
  // Shared modules stay on stable entry names. A hashed chunk name would
  // change whenever the bundle text changes.
  hash: false,
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  external: [/^@deepseek-ai\//],
})
