import type { Muya } from '../../../muya';
import type { IHtmlBlockState, IHtmlFrameMeta } from '../../../state/types';
import type { TBlockPath } from '../../types';
import { CLASS_NAMES } from '../../../config';
import { asDoc } from '../../../state';
import Parent from '../../base/parent';
import { ScrollPage } from '../../scrollPage';

class HTMLBlock extends Parent {
    static override blockName = 'html-block';

    static create(muya: Muya, state: IHtmlBlockState) {
        const htmlBlock = new HTMLBlock(muya, state);

        const htmlPreview = ScrollPage.loadBlock('html-preview').create(
            muya,
            state,
        );
        const htmlContainer = ScrollPage.loadBlock('html-container').create(
            muya,
            state,
        );

        htmlBlock.appendAttachment(htmlPreview);
        htmlBlock.append(htmlContainer);

        return htmlBlock;
    }

    override get path() {
        const { path: pPath } = this.parent!;
        const offset = this.parent!.offset(this);

        return [...pPath, offset];
    }

    // 用户拖拽/缩放过外框后的尺寸（`state.meta` 的镜像）。构造函数里存入，
    // `setFrameMeta` 更新；`getState()` 读它，保证滚动重渲染后尺寸不丢。
    private _frameMeta: IHtmlFrameMeta;

    constructor(muya: Muya, state?: IHtmlBlockState) {
        super(muya);
        this.tagName = 'figure';
        this.classList = [CLASS_NAMES.MU_HTML_BLOCK];
        const { disableHtml } = muya.options;
        if (disableHtml)
            this.classList.push(CLASS_NAMES.MU_DISABLE_HTML_RENDER);

        this._frameMeta = { ...state?.meta };
        this.createDomNode();
    }

    queryBlock(path: TBlockPath) {
        return path.length && path[0] === 'text'
            ? this.firstContentInDescendant()
            : this;
    }

    /**
     * 把外框尺寸写回块状态（并因此触发 json-change → 应用标记「已修改」+ 存盘）。
     *
     * 只在用户交互**结束时**调用一次（拖拽抬手 / 点缩放按钮），拖拽过程中每帧都写
     * 会让文档状态与 DOM 每帧对账、界面闪烁。`history` 的 `userOnly` 关闭时这会进
     * 撤销栈 —— 与图片拖拽改尺寸同一行为。
     */
    setFrameMeta(meta: IHtmlFrameMeta) {
        const oldMeta = this._frameMeta;
        this._frameMeta = meta;

        const { path } = this;
        path.push('meta');
        this.jsonState.replaceOperation(path, asDoc(oldMeta), asDoc(meta));
    }

    override getState(): IHtmlBlockState {
        const state: IHtmlBlockState = {
            name: 'html-block',
            meta: { ...this._frameMeta },
            text: this.firstContentInDescendant()?.text ?? '',
        };

        return state;
    }
}

export default HTMLBlock;
