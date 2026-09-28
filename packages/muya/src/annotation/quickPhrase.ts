/**
 * 常用语（Quick Phrases）的纯函数与常量：卡片、设置面板与单测共用。
 *
 * 这里只放与 DOM / 模块状态无关的规则，语义照标注原型 v8 的
 * `composeNote` / `collectable`（原型 §1.2 备注合成 · §1.5 采集）。
 */

/** 单条常用语的长度上限（trim 后按码点数计，与原型 `Array.from` 口径一致）。 */
export const QUICK_PHRASE_MAX_LEN = 24;
/** 常用语条数上限。 */
export const QUICK_PHRASE_MAX_COUNT = 9;

/**
 * 把一条常用语并进备注：输入框里有用户手写的字时，追加而不是覆盖。
 *
 * - 空输入框 → 这句短语本身就是备注；
 * - 任一行 trim 后与该短语全等 → 已包含，原样返回（重复点同一枚 chip 不会叠行）；
 * - 其余情况 → 去尾部换行后换行追加（末尾已是换行则不再补一个空行）。
 *
 * 第三条参数是共用签名（卡片 / 面板 / 桌面调用点一致），本函数用不到；
 * `_` 前缀满足 `noUnusedParameters`。
 */
export function composeNote(value: string, phrase: string, _phrases: string[]): string {
    const text = String(value ?? '');

    if (!text.trim())
        return phrase;

    if (text.split('\n').some(line => line.trim() === phrase))
        return text;

    return `${text.replace(/\n+$/, '')}\n${phrase}`;
}

/**
 * 「＋ 存为常用语」的可采集判定：通过则返回 trim 后的值，否则 null。
 *
 * 列表已满 / 空值 / 含换行（备注只有一行才可采集）/ 超出长度 / 与现有重复
 * 都不可采集。
 */
export function collectablePhrase(
    value: string,
    phrases: string[],
    maxLen: number = QUICK_PHRASE_MAX_LEN,
    maxCount: number = QUICK_PHRASE_MAX_COUNT,
): string | null {
    if (phrases.length >= maxCount)
        return null;

    const text = String(value ?? '').trim();

    if (!text)
        return null;
    if (text.includes('\n'))
        return null;
    if ([...text].length > maxLen)
        return null;
    if (phrases.includes(text))
        return null;

    return text;
}
