import { afterEach, describe, expect, it, vi } from 'vitest'
import { motionReduced } from '@/util/motion'

// 极速模式不再关闭界面动效：动效降级只跟随系统「减少动态效果」。

const originalMatchMedia = window.matchMedia

const stubReducedMotion = (matches: boolean): void => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })) as unknown as typeof window.matchMedia
}

afterEach(() => {
  window.matchMedia = originalMatchMedia
})

describe('motionReduced', () => {
  it('follows the system reduced-motion preference only', () => {
    stubReducedMotion(true)
    expect(motionReduced()).toBe(true)
    stubReducedMotion(false)
    expect(motionReduced()).toBe(false)
  })
})
