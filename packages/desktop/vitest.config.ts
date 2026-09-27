import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  test: {
    environment: 'jsdom',
    // feat/annotations：内容标注的用例单独收在 test/unit/annotation/ 下
    // （契约指定的路径），所以 include 要显式带上它——否则
    // `npx vitest run test/unit/annotation` 会「No test files found」。
    include: ['test/unit/specs/**/*.spec.ts', 'test/unit/annotation/**/*.spec.ts'],
    globals: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      common: resolve(__dirname, 'src/common'),
      muya: resolve(__dirname, '../muyajs'),
      '@shared': resolve(__dirname, 'src/shared'),
      main_renderer: resolve(__dirname, 'src/main')
    },
    extensions: ['.mjs', '.ts', '.js', '.json']
  }
})
