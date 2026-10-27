import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown } from './helpers'

// 极速模式下标签指示条必须跟着活动标签走。
//
// 极速模式保留正常动效；这里除了最终对齐，还覆盖 WAAPI 残留动画不能压住后续
// 定位（系统 reduced-motion 分支会走瞬移）。先在正常模式切两次标签，再开极速
// 模式切一次，等动画结束后断言几何。

const indicatorGeometry = (page: Page) =>
  page.evaluate(() => {
    const tabContainer = document.querySelector('.tabstrip')
    const active = document.querySelector('.tab.active .tn') as HTMLElement | null
    const indicator = document.querySelector('.tab-indicator') as HTMLElement | null
    const tabs = [...document.querySelectorAll('.tab')]
    return {
      activeIndex: tabs.findIndex((tab) => tab.classList.contains('active')),
      tabCount: tabs.length,
      containerWidth: tabContainer?.getBoundingClientRect().width ?? 0,
      activeLeft: active?.getBoundingClientRect().left ?? 0,
      activeWidth: active?.getBoundingClientRect().width ?? 0,
      indicatorLeft: indicator?.getBoundingClientRect().left ?? 0,
      indicatorWidth: indicator?.getBoundingClientRect().width ?? 0,
      indicatorOpacity: indicator ? getComputedStyle(indicator).opacity : '0'
    }
  })

test.describe('turbo mode: tab indicator follows the active tab', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithMarkdown('# 标签指示条\n\n第一页。\n', {
      suppressErrorDialog: true
    })
    app = launched.app
    page = launched.page
    await page.waitForSelector('.tab', { timeout: 15000 })
  })

  test.afterAll(async () => {
    if (app) {
      // 第二个标签是未保存的新文档，正常关窗会停在保存对话框上。
      await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
      await app.close().catch(() => {})
    }
  })

  test('indicator lands on the new tab after switching in turbo mode', async () => {
    // 造第二个标签，并在正常模式下切两次，让 WAAPI 动画正常结束（fill: forwards）。
    await page.click('.tab-new')
    await expect.poll(() => page.locator('.tab').count(), { timeout: 15000 }).toBe(2)
    await page.locator('.tab').nth(0).click()
    await page.waitForTimeout(450)
    await page.locator('.tab').nth(1).click()
    await page.waitForTimeout(450)

    // 开启极速模式（走和设置页同一条偏好通道）。网页档消失、只留文档/标注。
    await page.evaluate(() => {
      window.electron.ipcRenderer.send('mt::set-user-preference', { turboMode: true })
    })
    await page.waitForFunction(() => !document.querySelector('.bp-modes button[title="网页模式"]'))

    // 再切回第一个标签：保留的 300ms 滑轨动画结束后，指示条必须落在活动标签上。
    await page.locator('.tab').nth(0).click()
    await page.waitForTimeout(450)

    const state = await indicatorGeometry(page)
    expect(state.tabCount).toBe(2)
    expect(state.activeIndex).toBe(0)
    expect(state.indicatorOpacity).toBe('1')
    expect(Math.abs(state.indicatorLeft - state.activeLeft)).toBeLessThan(2)
    expect(Math.abs(state.indicatorWidth - state.activeWidth)).toBeLessThan(2)
  })
})
