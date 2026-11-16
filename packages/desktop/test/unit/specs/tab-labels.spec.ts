import { describe, it, expect } from 'vitest'
import { getTabLabels } from '@/util/tabLabels'

const tab = (id: string, filename: string, pathname = '') => ({ id, filename, pathname })

describe('getTabLabels', () => {
  it('uses the bare filename when it is unique', () => {
    const labels = getTabLabels([
      tab('a', 'prd.md', '/x/prd.md'),
      tab('b', 'index.html', '/x/p/index.html')
    ])
    expect(labels.get('a')).toBe('prd.md')
    expect(labels.get('b')).toBe('index.html')
  })

  it('adds the nearest parent folder to tell same-named files apart', () => {
    const labels = getTabLabels([
      tab('a', 'index.html', '/w/proto-a/index.html'),
      tab('b', 'index.html', '/w/proto-b/index.html')
    ])
    expect(labels.get('a')).toBe('index.html · proto-a')
    expect(labels.get('b')).toBe('index.html · proto-b')
  })

  it('walks up until the folders differ', () => {
    const labels = getTabLabels([
      tab('a', 'index.html', '/w/v1/proto/index.html'),
      tab('b', 'index.html', '/w/v2/proto/index.html'),
      tab('c', 'index.html', '/w/v2/other/index.html')
    ])
    expect(labels.get('a')).toBe('index.html · v1/proto')
    expect(labels.get('b')).toBe('index.html · v2/proto')
    expect(labels.get('c')).toBe('index.html · other')
  })

  it('handles Windows separators', () => {
    const labels = getTabLabels([
      tab('a', 'a.md', 'C:\\docs\\one\\a.md'),
      tab('b', 'a.md', 'C:\\docs\\two\\a.md')
    ])
    expect(labels.get('a')).toBe('a.md · one')
    expect(labels.get('b')).toBe('a.md · two')
  })

  it('numbers same-named tabs without a path in order', () => {
    const labels = getTabLabels([tab('a', 'Demo'), tab('b', 'Demo'), tab('c', 'Demo')])
    expect(labels.get('a')).toBe('Demo')
    expect(labels.get('b')).toBe('Demo (2)')
    expect(labels.get('c')).toBe('Demo (3)')
  })

  it('a snapshot sharing a name with a file keeps the bare name, the file gets its folder', () => {
    const labels = getTabLabels([tab('a', 'demo.html', '/w/p/demo.html'), tab('b', 'demo.html')])
    expect(labels.get('a')).toBe('demo.html · p')
    expect(labels.get('b')).toBe('demo.html')
  })

  it('labels every tab', () => {
    const tabs = [tab('a', 'x'), tab('b', 'y', '/y'), tab('c', 'x', '/q/x')]
    expect(getTabLabels(tabs).size).toBe(3)
  })
})
