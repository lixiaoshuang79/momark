// 系统「减少动态效果」是唯一的动效降级来源；极速模式不再关闭界面动效。
export const motionReduced = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
