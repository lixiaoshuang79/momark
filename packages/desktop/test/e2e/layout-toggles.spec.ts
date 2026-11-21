import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown, clickMenuById } from './helpers'

// Wait until a `v-show`-toggled element's visibility differs from `wasVisible`.
// A missing element counts as "not visible", so the change-detection logic
// stays consistent whether v-show clears the inline style or unmounts the node.
const waitForVisibilityFlip = (page: Page, selector: string, wasVisible: boolean) =>
  page.waitForFunction(
    ({ sel, prior }) => {
      const el = document.querySelector(sel) as HTMLElement | null
      const visible = !!(el && el.style.display !== 'none' && el.offsetParent !== null)
      return visible !== prior
    },
    { sel: selector, prior: wasVisible },
    { timeout: 5000 }
  )

test.describe('Layout panel toggles', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithMarkdown('# Layout\n\n## Section A\n\n## Section B\n')
    app = launched.app
    page = launched.page
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('Tab bar toggle flips .editor-tabs visibility', async () => {
    const tabBar = page.locator('.editor-tabs')
    const initial = await tabBar.isVisible()
    await clickMenuById(app, 'tabBarMenuItem')
    await waitForVisibilityFlip(page, '.editor-tabs', initial)
    const afterToggle = await tabBar.isVisible()
    expect(afterToggle).not.toBe(initial)
    await clickMenuById(app, 'tabBarMenuItem')
  })

  // 左侧边栏移除后，编辑区左边只剩标题轨：横线模式 48px、常驻模式按窗宽，
  // 编辑区必须吃满剩下的宽度（不能沿用旧侧栏宽度留出空洞）。
  test('Editor fills the width beside the heading rail in both rail modes', async () => {
    await page.waitForSelector('.heading-rail.shown', { timeout: 10000 })
    const measure = () =>
      page.evaluate(() => {
        const editor = document.querySelector('.editor-with-tabs') as HTMLElement
        const rail = document.querySelector('.heading-rail') as HTMLElement
        return {
          editor: editor.getBoundingClientRect().width,
          rail: rail.getBoundingClientRect().width,
          viewport: window.innerWidth
        }
      })
    const dash = await measure()
    expect(Math.round(dash.rail)).toBe(48)
    expect(Math.abs(dash.editor - (dash.viewport - dash.rail))).toBeLessThanOrEqual(1)

    await clickMenuById(app, 'headingLabelsMenuItem')
    await page.waitForTimeout(700)
    const pinned = await measure()
    expect(pinned.rail).toBeGreaterThanOrEqual(188)
    expect(Math.abs(pinned.editor - (pinned.viewport - pinned.rail))).toBeLessThanOrEqual(1)
    await clickMenuById(app, 'headingLabelsMenuItem')
    await page.waitForTimeout(700)
  })
})
