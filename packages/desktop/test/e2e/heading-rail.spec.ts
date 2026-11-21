import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown, clickMenuById, sendIpcToRenderer } from './helpers'

// 左侧边栏移除后（feat/heading-rail），文档结构由编辑区左缘的标题轨承担：
// 默认只有横线、悬停出完整标题、墨蓝指示线跟随阅读位置、点击跳转、可切换常驻完整
// 标题；源码模式跟随 CodeMirror（#3580 的「跳到顶部」语义保留）；同目录文件改由
// 文件夹抽屉提供。原 toc-scroll / source-toc-scroll / toc-panel-content 的断言并入此处。

const HEADING_COUNT = 20
const LONG_TITLE =
  'Heading Number 1 with a deliberately long title that cannot fit in the pinned outline column'
const buildLongDoc = (): string => {
  const parts: string[] = []
  for (let i = 1; i <= HEADING_COUNT; i++) {
    const level = i % 4 === 0 ? '###' : i % 2 === 0 ? '##' : '#'
    parts.push(`${level} ${i === 1 ? LONG_TITLE : `Heading Number ${i}`}`)
    for (let p = 0; p < 6; p++) {
      parts.push(
        `Filler paragraph ${p} under heading ${i}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`
      )
    }
  }
  return parts.join('\n\n') + '\n'
}

const HEADINGS = '.mu-container > h1, .mu-container > h2, .mu-container > h3'

const rowCount = (page: Page) => page.locator('.hr-row').count()
const activeRow = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.hr-row.active')
    return el ? Number(el.id.replace('hr-row-', '')) : -1
  })
const railWidth = (page: Page) =>
  page.evaluate(() =>
    Math.round(document.querySelector('.heading-rail')!.getBoundingClientRect().width)
  )
const scrollTop = (page: Page, sel: string) =>
  page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.scrollTop ?? -1, sel)
const headingTopInEditor = (page: Page, index: number) =>
  page.evaluate(
    ({ idx, sel }) => {
      const c = document.querySelector('.editor-component') as HTMLElement
      const h = document.querySelectorAll(sel)[idx] as HTMLElement | undefined
      return h ? h.getBoundingClientRect().top - c.getBoundingClientRect().top : null
    },
    { idx: index, sel: HEADINGS }
  )
const hoverRow = async (page: Page, index: number) => {
  const box = (await page.locator(`#hr-row-${index}`).boundingBox())!
  await page.mouse.move(box.x + 10, box.y + box.height / 2)
}
const rowIndexByLabel = (page: Page, label: string) =>
  page.evaluate((l) => {
    const row = document.querySelector(`.hr-row[aria-label="${l}"]`)
    return row ? Number(row.id.replace('hr-row-', '')) : -1
  }, label)
// 每一根横线当前的背景色（逐帧采样用）。
const dashColors = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.hr-row .hr-dash')].map(
      (el) => getComputedStyle(el).backgroundColor
    )
  )
const ACCENT_RGB = 'rgb(61, 90, 128)'
const clickRow = async (page: Page, index: number) => {
  const box = (await page.locator(`#hr-row-${index}`).boundingBox())!
  await page.mouse.click(box.x + 10, box.y + box.height / 2)
}

test.describe('Heading rail', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithMarkdown(buildLongDoc())
    app = launched.app
    page = launched.page
    await page.waitForSelector('.heading-rail.shown', { timeout: 10000 })
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('replaces the left sidebar with a dash-only rail by default', async () => {
    expect(await page.locator('.side-bar').count()).toBe(0)
    expect(await rowCount(page)).toBe(HEADING_COUNT)
    expect(await railWidth(page)).toBe(48)
    expect(await page.locator('.heading-rail').getAttribute('class')).not.toContain('pinned')
    // 层级 → 横线长度：H1 > H2 > H3。
    const widths = await page.evaluate(() =>
      [0, 1, 3].map(
        (i) => document.querySelector(`#hr-row-${i} .hr-dash`)!.getBoundingClientRect().width
      )
    )
    expect(widths[0]).toBeGreaterThan(widths[1]!)
    expect(widths[1]).toBeGreaterThan(widths[2]!)
    // 文字不显示（只有横线）。
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('#hr-row-5 .hr-text')!).opacity
      )
    ).toBe('0')
  })

  test('hovering a dash shows that heading’s full title, leaving hides it', async () => {
    await hoverRow(page, 0)
    const label = page.locator('.hr-label.show')
    await expect(label).toBeVisible()
    await expect(label).toContainText(LONG_TITLE)
    await expect(label).toContainText('H1')
    await hoverRow(page, 7)
    await expect(label).toContainText('Heading Number 8')
    await page.mouse.move(700, 400)
    await expect(page.locator('.hr-label.show')).toHaveCount(0)
  })

  test('clicking a deep dash scrolls the editor to that heading and marks it current', async () => {
    await page.evaluate(() => {
      ;(document.querySelector('.editor-component') as HTMLElement).scrollTop = 0
    })
    await clickRow(page, 17)
    await expect
      .poll(() => scrollTop(page, '.editor-component'), { timeout: 8000 })
      .toBeGreaterThan(0)
    await expect.poll(() => headingTopInEditor(page, 17), { timeout: 8000 }).toBeLessThan(400)
    await page.mouse.move(700, 400)
    await expect.poll(() => activeRow(page), { timeout: 8000 }).toBe(17)
    // 当前标题就是它自己那根横线变墨蓝（--accent）、变长变粗；不另画指示条。
    expect(await page.locator('.hr-indicator').count()).toBe(0)
    await page.waitForTimeout(450)
    const look = await page.evaluate(() => {
      const box = (i: number) =>
        document.querySelector(`#hr-row-${i} .hr-dash`)!.getBoundingClientRect()
      const row = document.querySelector('#hr-row-17')!.getBoundingClientRect()
      return {
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        color: getComputedStyle(document.querySelector('#hr-row-17 .hr-dash')!).backgroundColor,
        plain: getComputedStyle(document.querySelector('#hr-row-13 .hr-dash')!).backgroundColor,
        // 17 与 13 同为 H2：比较同级的普通横线。
        active: { w: box(17).width, h: box(17).height, top: box(17).top, bottom: box(17).bottom },
        normal: { w: box(13).width, h: box(13).height },
        row: { top: row.top, bottom: row.bottom }
      }
    })
    expect(look.accent.toLowerCase()).toBe('#3d5a80')
    expect(look.color).toBe(ACCENT_RGB)
    expect(look.plain).not.toBe(ACCENT_RGB)
    expect(look.active.w).toBeGreaterThan(look.normal.w * 1.2)
    expect(look.active.h).toBeGreaterThan(look.normal.h * 1.3)
    // 放大后的横线仍在自己那一行里。
    expect(look.active.top).toBeGreaterThanOrEqual(look.row.top - 0.5)
    expect(look.active.bottom).toBeLessThanOrEqual(look.row.bottom + 0.5)
  })

  test('clicking an earlier dash scrolls back up', async () => {
    const from = await scrollTop(page, '.editor-component')
    // 过渡期间逐帧采样：只有旧行（17）与新行（2）的横线可以偏离普通色，
    // 也就是旧线就地回落、新线就地变色，没有东西在行间移动。
    await page.evaluate(() => {
      const w = window as unknown as { __hrOdd: Set<number>; __hrStop: boolean }
      w.__hrOdd = new Set()
      w.__hrStop = false
      const plain = new Map<string, number>()
      document.querySelectorAll('.hr-row .hr-dash').forEach((el, i) => {
        if (i !== 17) plain.set(getComputedStyle(el).backgroundColor, 1)
      })
      const tick = (): void => {
        document.querySelectorAll('.hr-row .hr-dash').forEach((el, i) => {
          if (!plain.has(getComputedStyle(el).backgroundColor)) w.__hrOdd.add(i)
        })
        if (!w.__hrStop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await clickRow(page, 2)
    await expect
      .poll(() => scrollTop(page, '.editor-component'), { timeout: 8000 })
      .toBeLessThan(from)
    await page.mouse.move(700, 400)
    await expect.poll(() => activeRow(page), { timeout: 8000 }).toBe(2)
    await page.waitForTimeout(450)
    const odd = await page.evaluate(() => {
      const w = window as unknown as { __hrOdd: Set<number>; __hrStop: boolean }
      w.__hrStop = true
      return [...w.__hrOdd].sort((a, b) => a - b)
    })
    // 悬停的那条（2）也会加深，同样在新行上。
    expect(odd.every((i) => i === 2 || i === 17)).toBe(true)
    const colors = await dashColors(page)
    expect(colors[2]).toBe(ACCENT_RGB)
    expect(colors.filter((c) => c === ACCENT_RGB)).toHaveLength(1)
  })

  test('the current heading follows manual scrolling monotonically', async () => {
    await page.evaluate(() => {
      ;(document.querySelector('.editor-component') as HTMLElement).scrollTop = 0
    })
    let last = -1
    for (let step = 0; step < 12; step++) {
      await page.evaluate(() => {
        ;(document.querySelector('.editor-component') as HTMLElement).scrollTop += 600
      })
      await page.waitForTimeout(80)
      const now = await activeRow(page)
      expect(now).toBeGreaterThanOrEqual(last)
      last = now
    }
    expect(last).toBeGreaterThan(5)
  })

  test('the menu item pins full titles and the tab-bar button toggles back', async () => {
    await clickMenuById(app, 'headingLabelsMenuItem')
    await expect(page.locator('.heading-rail.pinned')).toHaveCount(1)
    await expect.poll(() => railWidth(page), { timeout: 3000 }).toBeGreaterThanOrEqual(188)
    await expect(page.locator('#hr-row-1 .hr-text')).toHaveCSS('opacity', '1')
    await expect(page.locator('.tb-headings.on')).toHaveCount(1)
    // 常驻模式的当前标题：本行左缘的墨蓝竖条 + 墨蓝文字；横线全部隐去。
    await page.waitForTimeout(700)
    const pinnedLook = await page.evaluate(() => {
      const row = document.querySelector('.hr-row.active')!
      const bar = getComputedStyle(row, '::after')
      const other = document.querySelector('.hr-row:not(.active)')!
      return {
        barOpacity: bar.opacity,
        barColor: bar.backgroundColor,
        otherBar: getComputedStyle(other, '::after').opacity,
        text: getComputedStyle(row.querySelector('.hr-text')!).color,
        dash: getComputedStyle(row.querySelector('.hr-dash')!).opacity
      }
    })
    expect(pinnedLook).toEqual({
      barOpacity: '1',
      barColor: ACCENT_RGB,
      otherBar: '0',
      text: ACCENT_RGB,
      dash: '0'
    })
    const checked = await app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('headingLabelsMenuItem')?.checked
    )
    expect(checked).toBe(true)

    // 常驻模式里截断的长标题，悬停就地展开完整文字。
    await page.evaluate(() => {
      ;(document.querySelector('.hr-list') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(200)
    await hoverRow(page, 0)
    await expect(page.locator('.hr-label.show')).toContainText(LONG_TITLE)
    // 未截断的短标题不弹浮层。
    await hoverRow(page, 1)
    await expect(page.locator('.hr-label.show')).toHaveCount(0)
    await page.mouse.move(700, 400)

    // 标签栏左侧按钮切回横线。
    await page.locator('.tb-headings').click()
    await expect(page.locator('.heading-rail.pinned')).toHaveCount(0)
    await expect.poll(() => railWidth(page), { timeout: 3000 }).toBe(48)
  })

  test('the folder drawer replaces the sidebar files tab', async () => {
    await clickMenuById(app, 'folderDrawerMenuItem')
    const drawer = page.locator('.folder-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.fd-row.sel')).toContainText('.md')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
  })

  test('source code mode: the rail follows CodeMirror and jumps put the heading at the top (#3580)', async () => {
    await clickMenuById(app, 'sourceCodeModeMenuItem')
    await page.waitForSelector('.source-code .CodeMirror', { timeout: 10000 })
    await expect.poll(() => rowCount(page), { timeout: 5000 }).toBeGreaterThanOrEqual(HEADING_COUNT)
    await page.evaluate(() => {
      ;(document.querySelector('.source-code') as HTMLElement).scrollTop = 0
    })
    const target = await rowIndexByLabel(page, 'Heading Number 18')
    expect(target).toBe(17)
    await clickRow(page, target)
    await expect.poll(() => scrollTop(page, '.source-code'), { timeout: 8000 }).toBeGreaterThan(0)
    const lineTop = () =>
      page.evaluate(() => {
        const sc = document.querySelector('.source-code') as HTMLElement
        const line = Array.from(document.querySelectorAll('.CodeMirror-line')).find((l) =>
          /^##?#? Heading Number 18$/.test(l.textContent || '')
        ) as HTMLElement | undefined
        return line ? line.getBoundingClientRect().top - sc.getBoundingClientRect().top : null
      })
    await expect.poll(lineTop, { timeout: 8000 }).toBeLessThan(150)
    expect(await lineTop()).toBeGreaterThan(-5)
    await page.mouse.move(700, 400)
    await expect.poll(() => activeRow(page), { timeout: 8000 }).toBe(target)
    await clickMenuById(app, 'sourceCodeModeMenuItem')
    await page.waitForSelector('.source-code', { state: 'detached', timeout: 10000 })
  })

  test('the rail updates live when a heading is added', async () => {
    const before = await rowCount(page)
    await page.evaluate(() => {
      ;(document.querySelector('.editor-component') as HTMLElement).scrollTop = 0
    })
    await page.locator('.mu-container > p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('## Added Live ', { delay: 20 })
    await expect.poll(() => rowCount(page), { timeout: 8000 }).toBe(before + 1)
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.hr-row')).map((r) => r.getAttribute('aria-label'))
    )
    // End 只到视觉行尾，段落可能被从中间拆开；只要新标题以输入的文字开头即可。
    expect(labels.some((l) => l?.startsWith('Added Live'))).toBe(true)
    // 存回临时文件，关窗时不弹「是否保存」。
    await sendIpcToRenderer(app, 'mt::editor-ask-file-save')
    await expect(page.locator('.title-stats .dot.show')).toHaveCount(0, { timeout: 5000 })
  })
})
