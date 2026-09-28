import { describe, it, expect } from 'vitest'

import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  SYNC_CHANNELS,
  isEventChannel,
  isInvokeChannel,
  isSendChannel,
  isSyncChannel
} from '../../../src/preload/channels'

// A-12 ②：preload 的通道白名单。**完整性**（漏一个通道 = 功能静默断）由
// `src/preload/channels.ts` 末尾的编译期断言保证（四个数组必须与
// `@shared/types/ipc` 的四个接口逐字相等，少一个/多一个都是 vue-tsc 报错）。
// 这里补的是运行时行为：集合内容、拒绝未知通道、没有重复项。
//
// 之所以要把「白名单 == 契约」这件事拆成编译期断言 + 运行期抽查：单测没法在
// 运行期枚举 TS 接口的键，而 vue-tsc 是必过门禁，两者合起来才是完整证明。
describe('preload IPC 通道白名单（A-12 ②）', () => {
  it('四类集合都非空，且与契约规模一致（防手改数组时被清空）', () => {
    expect(INVOKE_CHANNELS.length).toBeGreaterThan(40)
    expect(SEND_CHANNELS.length).toBeGreaterThan(80)
    expect(SYNC_CHANNELS.length).toBe(2)
    expect(EVENT_CHANNELS.length).toBeGreaterThan(50)
  })

  it('每个集合内部无重复项', () => {
    for (const list of [INVOKE_CHANNELS, SEND_CHANNELS, SYNC_CHANNELS, EVENT_CHANNELS]) {
      expect(new Set(list).size).toBe(list.length)
    }
  })

  it('关键通道在册（抽样，覆盖各功能域）', () => {
    for (const channel of [
      'mt::fs::read-file',
      'mt::fs::write-file',
      'mt::uploader::upload',
      'mt::shell::open-external',
      'mt::export::rasterize-html-frame',
      'mt::annotation::save',
      'bp:createPage'
    ]) {
      expect(isInvokeChannel(channel)).toBe(true)
    }
    for (const channel of [
      'mt::open-file',
      'mt::set-user-preference',
      'mt::response-file-save',
      'bp:setInputContext'
    ]) {
      expect(isSendChannel(channel)).toBe(true)
    }
    expect(isSyncChannel('mt::boot-info')).toBe(true)
    expect(isSyncChannel('mt::paths::is-same-sync')).toBe(true)
    for (const channel of ['mt::export-progress', 'mt::open-new-tab', 'settings::change-tab']) {
      expect(isEventChannel(channel)).toBe(true)
    }
  })

  it('未知通道一律不在册（构造出来的字符串进不了白名单）', () => {
    for (const channel of [
      'mt::fs::write-file ',
      'MT::FS::READ-FILE',
      'mt::fs::read-file-extra',
      '__proto__',
      'constructor',
      'mt::',
      ''
    ]) {
      expect(isInvokeChannel(channel)).toBe(false)
      expect(isSendChannel(channel)).toBe(false)
      expect(isSyncChannel(channel)).toBe(false)
      expect(isEventChannel(channel)).toBe(false)
    }
  })

  it('注入原型链上的属性名不会命中（用 Set 而非对象字面量查表）', () => {
    expect(isInvokeChannel('toString')).toBe(false)
    expect(isEventChannel('hasOwnProperty')).toBe(false)
  })
})
