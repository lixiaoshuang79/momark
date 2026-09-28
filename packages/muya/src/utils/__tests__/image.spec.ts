// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkImageContentType, getImageSrc, loadImage } from '../image';

// Regression tests for the Phase G "G1" blocker: relative-path images stopped
// rendering after the @muyajs/core migration because `getImageSrc` returned a
// non-anchored `file://assets/foo.png` instead of resolving the relative path
// against the document directory. Legacy muyajs `getImageInfo(src, baseUrl =
// window.DIRNAME)` did `'file://' + path.resolve(baseUrl, src)`; this suite
// pins the ported behaviour.
//
// A-12（webSecurity 恢复）之后，本地图片不再产出 `file://`，而是
// `momark-file://local/<逐段编码的绝对路径>`：宿主打开 webSecurity 后，dev 形态
// （http://localhost 应用页）与沙箱帧（不透明源）都加载不了 file://，只有自定义
// 协议在全部上下文可用。`file://` 形态的 src **原样透传**（不改写已有 file:// 的
// markdown），这一条也由本套件钉住。

const DIRNAME = '/home/user/docs';

function withDirname(dirname: string | undefined, fn: () => void) {
    const previous = window.DIRNAME;
    window.DIRNAME = dirname;
    try {
        fn();
    }
    finally {
        window.DIRNAME = previous;
    }
}

afterEach(() => {
    window.DIRNAME = undefined;
});

describe('checkImageContentType (#3837)', () => {
    // Same-origin URL — the only kind whose HEAD the renderer can actually read.
    const sameOrigin = (p: string) => new URL(p, window.location.href).href;
    const CROSS_ORIGIN = 'https://img.shields.io/badge/x-blue';

    function mockFetch(status: number, contentType: string | null) {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status,
                headers: {
                    get: (h: string) =>
                        h.toLowerCase() === 'content-type' ? contentType : null,
                },
            }),
        );
        return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('accepts a same-origin image type carrying a charset parameter', async () => {
        mockFetch(200, 'image/svg+xml;charset=utf-8');
        expect(await checkImageContentType(sameOrigin('/badge'))).toBe(true);
    });

    it('accepts a bare same-origin image content type', async () => {
        mockFetch(200, 'image/png');
        expect(await checkImageContentType(sameOrigin('/badge'))).toBe(true);
    });

    it('reports a same-origin non-image content type as false', async () => {
        mockFetch(200, 'text/html;charset=utf-8');
        expect(await checkImageContentType(sameOrigin('/page'))).toBe(false);
    });

    it('returns null (undetermined) on a non-200 response', async () => {
        mockFetch(404, 'image/png');
        expect(await checkImageContentType(sameOrigin('/missing'))).toBeNull();
    });

    it('returns null when the same-origin HEAD fails (network)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
        expect(await checkImageContentType(sameOrigin('/x'))).toBeNull();
    });

    it('skips the HEAD entirely for a cross-origin URL (CSP/CORS can never read it)', async () => {
        const fetchSpy = mockFetch(200, 'image/png');
        expect(await checkImageContentType(CROSS_ORIGIN)).toBeNull();
        // No wasted, guaranteed-to-fail request (and no CSP console error).
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('loadImage — undetermined content-type still attempts the load (#3837)', () => {
    // Drive the <img> load deterministically: setting `src` fires onload/onerror.
    function stubImage(succeeds: boolean) {
        class FakeImage {
            width = 10;
            height = 10;
            onload: (() => void) | null = null;
            onerror: ((err: unknown) => void) | null = null;
            private _src = '';
            get src(): string {
                return this._src;
            }

            set src(v: string) {
                this._src = v;
                queueMicrotask(() =>
                    succeeds ? this.onload?.() : this.onerror?.(new Error('load failed')),
                );
            }
        }
        vi.stubGlobal('Image', FakeImage);
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const sameOrigin = (p: string) => new URL(p, window.location.href).href;

    it('loads a cross-origin extensionless image (its HEAD check is skipped)', async () => {
        // The shields.io badge's content-type can't be read (CSP/CORS), so the
        // check is skipped and the badge must still load via the permissive img-src.
        stubImage(true);
        await expect(
            loadImage('https://img.shields.io/badge/example-blue', true),
        ).resolves.toMatchObject({ width: 10, height: 10 });
    });

    it('still rejects when a same-origin HEAD positively reports a non-image type', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ status: 200, headers: { get: () => 'text/html' } }),
        );
        stubImage(true);
        await expect(loadImage(sameOrigin('/page'), true)).rejects.toBe('not an image.');
    });
});

describe('getImageSrc — relative local image paths anchored to window.DIRNAME', () => {
    it('resolves a relative path against the document directory', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('assets/foo.png')).toEqual({
                isUnknownType: false,
                src: 'momark-file://local/home/user/docs/assets/foo.png',
            });
        });
    });

    it('resolves a `./` relative path', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('./img/cat.jpg').src).toBe(
                'momark-file://local/home/user/docs/img/cat.jpg',
            );
        });
    });

    it('collapses `../` parent segments', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('../shared/logo.svg').src).toBe(
                'momark-file://local/home/user/shared/logo.svg',
            );
        });
    });

    it('does not produce a double `momark-file://` prefix', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('assets/foo.png').src).not.toContain(
                'momark-file://momark-file://',
            );
        });
    });

    it('falls back to the bare-path form when window.DIRNAME is absent', () => {
        withDirname(undefined, () => {
            expect(getImageSrc('assets/foo.png')).toEqual({
                isUnknownType: false,
                src: 'momark-file://local/assets/foo.png',
            });
        });
    });

    it('resolves Windows-drive base dirs with forward slashes', () => {
        withDirname('C:\\Users\\me\\docs', () => {
            expect(getImageSrc('assets\\foo.png').src).toBe(
                'momark-file://local/C%3A/Users/me/docs/assets/foo.png',
            );
        });
    });
});

describe('getImageSrc — non-relative sources are left unchanged', () => {
    it('leaves an absolute POSIX local path as a single `momark-file://`', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('/var/img/pic.png')).toEqual({
                isUnknownType: false,
                src: 'momark-file://local/var/img/pic.png',
            });
        });
    });

    it('leaves an absolute Windows-drive path as a single `momark-file://`', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('C:/img/pic.png').src).toBe('momark-file://local/C%3A/img/pic.png');
        });
    });

    it('leaves an http(s) URL untouched', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('https://example.com/x.png')).toEqual({
                isUnknownType: false,
                src: 'https://example.com/x.png',
            });
        });
    });

    it('leaves an already-`file://` src untouched（A-12 遗留：只有裸路径会被改写）', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('file:///already/abs.png')).toEqual({
                isUnknownType: false,
                src: 'file:///already/abs.png',
            });
        });
    });

    it('leaves a data: URL untouched', () => {
        const dataUrl
            = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        withDirname(DIRNAME, () => {
            expect(getImageSrc(dataUrl)).toEqual({
                isUnknownType: false,
                src: dataUrl,
            });
        });
    });

    it('flags an extensionless http URL as unknown type', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('https://example.com/image')).toEqual({
                isUnknownType: true,
                src: 'https://example.com/image',
            });
        });
    });
});

describe('getImageSrc — Windows drive + UNC base directories (Phase G review)', () => {
    it('preserves the drive when resolving `..`', () => {
        withDirname('C:/Users/me/docs', () => {
            expect(getImageSrc('../img/a.png').src).toBe('momark-file://local/C%3A/Users/me/img/a.png');
        });
    });

    it('clamps `..` at the drive root so the drive is never lost', () => {
        withDirname('C:/docs', () => {
            expect(getImageSrc('../../../a.png').src).toBe('momark-file://local/C%3A/a.png');
        });
    });

    it('normalises a Windows-backslash base dir', () => {
        withDirname('C:\\docs', () => {
            expect(getImageSrc('a.png').src).toBe('momark-file://local/C%3A/docs/a.png');
        });
    });

    it('resolves against a UNC share base directory', () => {
        withDirname('//server/share/docs', () => {
            expect(getImageSrc('a.png').src).toBe('momark-file://local//server/share/docs/a.png');
        });
    });

    it('normalises a backslash UNC base', () => {
        withDirname('\\\\server\\share', () => {
            expect(getImageSrc('sub/a.png').src).toBe('momark-file://local//server/share/sub/a.png');
        });
    });

    it('clamps `..` at the UNC share root', () => {
        withDirname('//server/share/docs', () => {
            expect(getImageSrc('../../../a.png').src).toBe('momark-file://local//server/share/a.png');
        });
    });

    it('keeps the UNC host when resolving relative images from WSL paths', () => {
        withDirname('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\docs', () => {
            expect(getImageSrc('./img/my_image.png').src).toBe(
                'momark-file://local//wsl.localhost/Ubuntu-24.04/home/me/docs/img/my_image.png',
            );
        });
    });

    it('normalises an absolute UNC image path to a host-based file URL', () => {
        withDirname(DIRNAME, () => {
            expect(getImageSrc('\\\\server\\share\\img\\a.png').src).toBe(
                'momark-file://local//server/share/img/a.png',
            );
        });
    });
});
