/**
 * 常用语（Quick Phrases）的纯函数与常量：卡片、设置面板与单测共用。
 *
 * 这里只放与 DOM / 模块状态无关的规则，语义照标注原型 v8 的
 * `composeNote` / `collectable`（原型 §1.2 备注合成 · §1.5 采集）。
 */

/** 单条常用语的长度上限（规范化后按码点数计，与原型 `Array.from` 口径一致）。 */
export const QUICK_PHRASE_MAX_LEN = 24;
/** 常用语条数上限。 */
export const QUICK_PHRASE_MAX_COUNT = 9;

/**
 * 常用语的规范化：折叠所有空白（含中文输入法常见的全角空格 U+3000）为单个
 * 半角空格，再 trim。
 *
 * **判定、写入、回推三处必须共用这一份**：卡片用「输入框原文是否等于某条
 * 常用语」显隐「＋ 存为常用语」，桌面若按另一套规则（如只 trim）存盘，
 * 就会出现「按钮在、点了没反应、还回一个假回执」的漂移。桌面侧从
 * `@muyajs/core` 导入本函数，不要再手写一份。
 */
export function normalizePhrase(value: unknown): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 把一条常用语并进备注：输入框里有用户手写的字时，追加而不是覆盖。
 *
 * - 空输入框 → 这句短语本身就是备注；
 * - 任一行规范化后与该短语全等 → 已包含，原样返回（重复点同一枚 chip 不会叠行）；
 * - 其余情况 → 去掉尾部的空白与换行后换行追加（`"abc\n  \n"` 这类尾随空白行
 *   也要清干净，所以用 `trimEnd` 而不是只去 `\n`）。
 */
export function composeNote(value: string, phrase: string): string {
    const text = String(value ?? '');

    if (!text.trim())
        return phrase;

    if (text.split('\n').some(line => normalizePhrase(line) === normalizePhrase(phrase)))
        return text;

    return `${text.trimEnd()}\n${phrase}`;
}

/**
 * 「＋ 存为常用语」的可采集判定：通过则返回规范化后的值，否则 null。
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

    const raw = String(value ?? '');

    // 换行先于规范化判断：规范化会把换行压成空格，之后就看不出「备注多行」了。
    if (!raw.trim() || raw.trim().includes('\n'))
        return null;

    const text = normalizePhrase(raw);

    if (!text)
        return null;
    if ([...text].length > maxLen)
        return null;
    if (phrases.some(phrase => normalizePhrase(phrase) === text))
        return null;

    return text;
}

/**
 * 整表规范化（`setQuickPhrases` 与偏好写入共用）：逐条规范化、丢弃空值、
 * 去重、按上限截断。返回的数组可直接作为渲染数据。
 */
export function normalizePhraseList(
    list: unknown,
    maxCount: number = QUICK_PHRASE_MAX_COUNT,
): string[] {
    if (!Array.isArray(list))
        return [];

    const out: string[] = [];

    for (const item of list) {
        const phrase = normalizePhrase(item);
        if (!phrase || [...phrase].length > QUICK_PHRASE_MAX_LEN)
            continue;
        if (out.includes(phrase))
            continue;
        out.push(phrase);
        if (out.length >= maxCount)
            break;
    }

    return out;
}
