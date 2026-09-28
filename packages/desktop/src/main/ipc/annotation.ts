import path from 'path'
import { app } from 'electron'
import AnnotationStore from '../annotationStore'
import { trustedHandle } from './guard'

/**
 * 内容标注的三个 IPC 通道（feat/annotations，通道名见 shared/types/ipc.ts）。
 *
 * 标注库的实例建在这里而不是 Accessor：它与窗口生命周期无关（按文件路径绑定，
 * 不按窗口），是纯粹的文件存储，所以自持一个懒加载单例，避免改动
 * `main/app/accessor.ts`（不在本功能的文件所有权内）。
 */

let annotationStore: AnnotationStore | null = null

/** 懒建实例：`app.getPath('userData')` 只有 app ready 之后才可靠。 */
export const getAnnotationStore = (): AnnotationStore => {
  if (!annotationStore) {
    annotationStore = new AnnotationStore({
      annotationStorePath: path.join(app.getPath('userData'), 'annotations')
    })
  }
  return annotationStore
}

export const registerAnnotationHandlers = (): void => {
  trustedHandle('mt::annotation::load', (_event, pathname: string) =>
    getAnnotationStore().load(pathname)
  )

  trustedHandle('mt::annotation::save', (_event, payload) => getAnnotationStore().save(payload))

  trustedHandle('mt::annotation::migrate-path', (_event, payload) =>
    getAnnotationStore().migratePath(payload)
  )
}
