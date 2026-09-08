/**
 * 右栏分屏编辑器的图片持久化回调（round8：右栏文档从只读预览升级为
 * 真 Muya 编辑器后，图片粘贴/拖放行为与主编辑器对齐）。
 * 逻辑与 editor.vue 的 imageAction 同源，差异仅在 currentFile 由调用方
 * 提供（右栏编辑器绑定 split.tabId 的文档，而非当前活动标签）。
 */
import { storeToRefs } from 'pinia'
import { usePreferencesStore } from '@/store/preferences'
import { useProjectStore } from '@/store/project'
import { moveImageToFolder, uploadImage } from '@/util/fileSystem'
import type { UploadImagePreferences } from '@/util/fileSystem'
import { dataURLToFile } from '@/util/dataURLToFile'
import notice from '@/services/notification'

export type DocPaneTabRef = { filename?: string; pathname?: string } | null

export type DocPaneImageAction = (state: {
  src: string
  alt?: string
  title?: string
}) => Promise<string>

export const createImageAction = (getTab: () => DocPaneTabRef): DocPaneImageAction => {
  return async ({ src }): Promise<string> => {
    const tab = getTab()
    if (!tab) return src

    // 与主编辑器 imageAction 同签名：string（路径/data:）或二进制 File。
    let image: string | File = src

    const preferencesStore = usePreferencesStore()
    const {
      imageInsertAction,
      imagePreferRelativeDirectory,
      imageRelativeDirectoryBase,
      imageRelativeDirectoryName,
      imageFolderPath
    } = storeToRefs(preferencesStore)
    const { projectTree } = storeToRefs(useProjectStore())

    const filename = tab.filename ?? ''
    const currentPathname = tab.pathname ?? ''

    // 粘贴的截图/位图剪贴板是 data: URL 而非文件路径，先归一化成 File，
    // 否则 moveImageToFolder/uploadImage 会把它当本地路径原样保留 base64。
    if (typeof image === 'string' && image.startsWith('data:')) {
      const file = dataURLToFile(image)
      if (file) image = file
    }

    // 图片保存基准目录：文档已落盘 → 文档所在目录；相对目录基准为项目根时
    // 若文档在项目树下，改用项目根。
    const isTabSavedOnDisk = !!currentPathname
    let relativeBasePath: string | null = isTabSavedOnDisk
      ? window.path.dirname(currentPathname)
      : null
    if (isTabSavedOnDisk && imageRelativeDirectoryBase.value !== 'file' && projectTree.value) {
      const { pathname: rootPath } = projectTree.value as { pathname?: string }
      if (rootPath && window.fileUtils.isChildOfDirectory(rootPath, currentPathname)) {
        relativeBasePath = rootPath
      }
    }

    const getResolvedImagePath = (imagePath: string) => {
      const replacement = isTabSavedOnDisk ? filename.replace(/\.[^/.]+$/, '') : ''
      return imagePath.replace(/\${filename}/g, replacement)
    }

    const resolvedGlobalImageFolderPath = getResolvedImagePath(imageFolderPath.value)
    const resolvedImageRelativeDirectoryName = getResolvedImagePath(
      imageRelativeDirectoryName.value
    )
    const resolvedImageRelativeFullDirectoryPath = relativeBasePath
      ? window.path.join(relativeBasePath, resolvedImageRelativeDirectoryName)
      : null

    let destImagePath = ''
    switch (imageInsertAction.value) {
      case 'upload': {
        try {
          destImagePath = (await uploadImage(
            currentPathname,
            image,
            preferencesStore.$state as unknown as UploadImagePreferences
          )) as string
        } catch (err) {
          notice.notify({
            title: 'Upload Image',
            type: 'warning',
            message: err as string
          })
          destImagePath = (await moveImageToFolder(
            currentPathname,
            image,
            resolvedGlobalImageFolderPath
          )) as string
        }
        break
      }
      case 'folder': {
        if (isTabSavedOnDisk && imagePreferRelativeDirectory.value) {
          destImagePath = (await moveImageToFolder(
            currentPathname,
            image,
            resolvedImageRelativeFullDirectoryPath as string,
            true,
            currentPathname
          )) as string
        } else {
          destImagePath = (await moveImageToFolder(
            currentPathname,
            image,
            resolvedGlobalImageFolderPath
          )) as string
        }
        break
      }
      case 'path': {
        if (typeof image === 'string') {
          destImagePath = image
        } else {
          if (isTabSavedOnDisk && imagePreferRelativeDirectory.value) {
            destImagePath = (await moveImageToFolder(
              null as unknown as string,
              image,
              resolvedImageRelativeFullDirectoryPath as string,
              true,
              currentPathname
            )) as string
          } else {
            destImagePath = (await moveImageToFolder(
              currentPathname,
              image,
              resolvedGlobalImageFolderPath
            )) as string
          }
        }
        break
      }
    }

    return destImagePath
  }
}
