import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchWithMarkdown, setSourceMarkdown } from './helpers'

// 极速模式端到端：真实 <webview> 与真实 HTML 块 iframe。
//   - 开启：已开的网页 webview 被销毁、网页 tab 停用；正文链接改走系统浏览器；
//     HTML 块只剩源码（预览里没有 iframe / img），新文档里的预览资源一个都不请求。
//   - 关闭：HTML 预览按原偏好恢复；已关掉的网页不自动重开，链接重新进右栏。
// 页面与资源由本地 HTTP 服务提供，按路径记请求，用来断言「没有加载」。

const requests: string[] = []
const server = http.createServer((req, res) => {
  requests.push(req.url ?? '')
  if ((req.url ?? '').endsWith('.svg')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<!doctype html><title>t</title><p>hello</p>')
})

let origin = ''

const docFor = (tag: string): string =>
  [
    `[local page](${origin}/page-${tag})`,
    '',
    `<div class="pic"><img src="${origin}/img-${tag}.svg"></div>`,
    '',
    `<iframe src="${origin}/frame-${tag}" style="width:100%;height:120px"></iframe>`,
    '',
    '<div id="s"></div>',
    "<script>document.getElementById('s').textContent = 'ran'</script>",
    ''
  ].join('\n')

interface PreviewState {
  blocks: number
  disabledBlocks: number
  iframes: number
  imgs: number
  webviews: number
}

const previewState = (page: Page): Promise<PreviewState> =>
  page.evaluate(() => {
    const root = document.querySelector('.editor-component')
    return {
      blocks: root?.querySelectorAll('figure.mu-html-block').length ?? 0,
      disabledBlocks: root?.querySelectorAll('figure.mu-disable-html-render').length ?? 0,
      iframes: root?.querySelectorAll('.mu-html-preview iframe').length ?? 0,
      imgs: root?.querySelectorAll('.mu-html-preview img').length ?? 0,
      webviews: document.querySelectorAll('webview').length
    }
  })

const clickBodyLink = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const el = document.querySelector('.editor-component span.mu-link') as HTMLElement | null
    if (!el) return false
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true })
    )
    return true
  })

// 与设置页同一条通道：渲染层发给主进程落盘，主进程再广播回所有窗口。
const setTurbo = (page: Page, value: boolean): Promise<void> =>
  page.evaluate((v) => {
    window.electron.ipcRenderer.send('mt::set-user-preference', { turboMode: v })
  }, value)

const openedExternally = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (global as unknown as { __turboOpened: string[] }).__turboOpened.slice())

const processSnapshot = (app: ElectronApplication) =>
  app.evaluate(({ app: electronApp }) => {
    const metrics = electronApp.getAppMetrics()
    return {
      count: metrics.length,
      workingSetMB: Math.round(metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024),
      types: metrics.map((m) => m.type).sort()
    }
  })

test.describe.serial('turbo mode', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const launched = await launchWithMarkdown(docFor('a'), { suppressErrorDialog: true })
    app = launched.app
    page = launched.page
    // 「在默认浏览器中打开」只记录、不真的拉起系统浏览器。
    await app.evaluate(({ ipcMain }) => {
      const sink: string[] = []
      ;(global as unknown as { __turboOpened: string[] }).__turboOpened = sink
      ipcMain.removeHandler('bp:openExternal')
      ipcMain.handle('bp:openExternal', (_e, url: string) => {
        sink.push(url)
        return true
      })
    })
  })

  test.afterAll(async () => {
    if (app) {
      // setSourceMarkdown 把文档改脏了，正常关窗会停在「是否保存」对话框上。
      await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
      await app.close().catch(() => {})
    }
    server.close()
  })

  test('baseline: HTML previews render and body links open a panel webview', async () => {
    await expect
      .poll(() => previewState(page), { timeout: 15000 })
      .toMatchObject({ blocks: 3, disabledBlocks: 0, imgs: 1, iframes: 2 })

    expect(await clickBodyLink(page)).toBe(true)
    await expect.poll(() => previewState(page)).toMatchObject({ webviews: 1 })
    await expect.poll(() => requests.includes('/page-a'), { timeout: 15000 }).toBe(true)
  })

  test('turning turbo on destroys the webview and strips HTML previews in place', async () => {
    const figureBefore = await page.evaluateHandle(() =>
      document.querySelector('.editor-component figure.mu-html-block')
    )
    const before = await processSnapshot(app)

    await setTurbo(page, true)

    await expect
      .poll(() => previewState(page))
      .toEqual({ blocks: 3, disabledBlocks: 3, iframes: 0, imgs: 0, webviews: 0 })
    // 就地刷新：HTML 块还是原来那个 DOM 节点，没有整篇重建。
    expect(
      await page.evaluate(
        (el) => el === document.querySelector('.editor-component figure.mu-html-block'),
        figureBefore
      )
    ).toBe(true)
    // 源码照常显示。
    expect(
      await page.evaluate(
        () =>
          document.querySelector('.editor-component figure.mu-html-block .mu-html-container')
            ?.textContent ?? ''
      )
    ).toContain('img-a.svg')

    // 网页档整个移除；默认开着标注时只剩「文档 / 标注」两档。
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('.bp-modes button')].map((btn) =>
          (btn.textContent ?? '').trim()
        )
      )
    ).toEqual(['文档', '标注'])
    expect(await page.evaluate(() => !!document.querySelector('.bpanel.collapsed'))).toBe(true)

    // webview guest 与 iframe 的进程退出后，进程数下降。
    await expect
      .poll(async () => (await processSnapshot(app)).count, { timeout: 15000 })
      .toBeLessThan(before.count)
    const after = await processSnapshot(app)
    console.log(
      `[turbo e2e] processes ${before.count} -> ${after.count}, working set ${before.workingSetMB}MB -> ${after.workingSetMB}MB`
    )
    console.log(`[turbo e2e] before: ${before.types.join(',')}`)
    console.log(`[turbo e2e] after:  ${after.types.join(',')}`)
  })

  test('in turbo mode links go to the default browser and previews load nothing', async () => {
    expect(await clickBodyLink(page)).toBe(true)
    await expect.poll(() => openedExternally(app)).toEqual([`${origin}/page-a`])
    expect((await previewState(page)).webviews).toBe(0)

    const sent = requests.length
    await setSourceMarkdown(page, app, docFor('b'))
    await expect
      .poll(() => previewState(page))
      .toMatchObject({ blocks: 3, disabledBlocks: 3, iframes: 0, imgs: 0, webviews: 0 })
    // 给可能的加载留一点时间，再确认新文档的预览资源一个都没请求。
    await page.waitForTimeout(1000)
    expect(requests.slice(sent).filter((url) => url.endsWith('-b') || url.includes('-b.'))).toEqual(
      []
    )
  })

  test('turning turbo off restores previews but not the closed pages', async () => {
    await setTurbo(page, false)

    await expect
      .poll(() => previewState(page))
      .toMatchObject({ blocks: 3, disabledBlocks: 0, imgs: 1, iframes: 2, webviews: 0 })
    expect(
      await page.evaluate(() => {
        const urlBtn = [...document.querySelectorAll('.bp-modes button')].find((btn) =>
          (btn.textContent ?? '').includes('网页')
        ) as HTMLButtonElement | undefined
        return { exists: !!urlBtn, disabled: urlBtn?.disabled ?? null }
      })
    ).toEqual({ exists: true, disabled: false })

    expect(await clickBodyLink(page)).toBe(true)
    await expect.poll(() => previewState(page)).toMatchObject({ webviews: 1 })
    expect(await openedExternally(app)).toEqual([`${origin}/page-a`])
  })
})

// 极速模式保留界面动效；右栏开合的动画成本不再作为极速模式的断言。
