import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

/**
 * Auto-applied fixtures shared by every spec in tests/e2e.
 *
 * - `cleanStorage` removes app-owned localStorage keys on every navigation, so
 *   each test starts from the default app state (default `info` tab, no
 *   features).
 * - `failOnConsoleError` collects console errors and uncaught page errors, then
 *   fails the test during teardown when any were seen. Console warnings are
 *   logged but never fail a test. The teardown error reports the current page
 *   URL and every collected message, one per line.
 * - `mapTileTracker` records successfully finished Protomaps tile requests per
 *   page from before navigation, so `captureScreenshot` can gate on real map
 *   rendering.
 */
export const test = base.extend<{
    cleanStorage: void;
    failOnConsoleError: void;
    mapTileTracker: void;
}>({
    cleanStorage: [
        async ({ context }, use) => {
            await context.addInitScript(() => {
                try {
                    localStorage.removeItem("terra-draw");
                    localStorage.removeItem("tab");
                } catch {
                    // localStorage is unavailable on opaque origins (e.g. about:blank).
                }
            });

            await use();
        },
        { auto: true },
    ],

    mapTileTracker: [
        async ({ page }, use) => {
            const tileUrls: string[] = [];
            mapTileUrlsByPage.set(page, tileUrls);

            // `requestfinished` (not `response`) so the tile body is fully
            // downloaded; the app's only tile host is Protomaps.
            page.on("requestfinished", (request) => {
                if (isMapTileUrl(request.url())) {
                    tileUrls.push(request.url());
                }
            });

            await use();
        },
        { auto: true },
    ],

    failOnConsoleError: [
        async ({ page }, use) => {
            const errors: string[] = [];

            page.on("console", (message) => {
                if (message.type() === "error") {
                    const { url, lineNumber } = message.location();
                    const where = url ? ` (${url}:${lineNumber})` : "";
                    errors.push(`[console.error] ${message.text()}${where}`);
                } else if (message.type() === "warning") {
                    console.warn(`[page warning] ${message.text()}`);
                }
            });

            page.on("pageerror", (error) => {
                errors.push(`[pageerror] ${error.message}`);
            });

            await use();

            if (errors.length > 0) {
                throw new Error(
                    [`Console/page errors detected on ${page.url()}:`, ...errors].join("\n"),
                );
            }
        },
        { auto: true },
    ],
});

const mapTileUrlsByPage = new WeakMap<Page, string[]>();

/** Protomaps vector tiles, e.g. https://api.protomaps.com/tiles/v3/3/1/2.mvt?key=... */
function isMapTileUrl(url: string) {
    return url.includes("protomaps.com") && /\/tiles\/v\d+\/\d+\/\d+\/\d+\.mvt/.test(url);
}

/** Live list of finished map-tile requests for a tracked page (oldest first). */
export function getMapTileUrls(page: Page): readonly string[] {
    return mapTileUrlsByPage.get(page) ?? [];
}

export type ColourProperty = "backgroundColor" | "color";

/**
 * WCAG relative luminance (0 = black, 1 = white) of an element's computed
 * `backgroundColor` or `color`.
 *
 * Throws instead of returning a misleading value when the element is missing
 * or the colour is fully transparent: a transparent body background would
 * otherwise score 0 and silently "pass" a dark-surface check.
 */
export async function relativeLuminance(
    page: Page,
    selector: string,
    property: ColourProperty,
): Promise<number> {
    return page.evaluate(
        ({
            cssSelector,
            cssProperty,
        }: {
            cssSelector: string;
            cssProperty: ColourProperty;
        }) => {
            const element = document.querySelector(cssSelector);
            if (!element) {
                throw new Error(`No element matches selector "${cssSelector}"`);
            }

            const value = getComputedStyle(element)[cssProperty];
            const match =
                /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(
                    value,
                );
            if (!match) {
                throw new Error(
                    `Cannot parse computed ${cssProperty} "${value}" for "${cssSelector}"`,
                );
            }

            const alpha = match[4] === undefined ? 1 : Number(match[4]);
            if (alpha === 0) {
                throw new Error(
                    `Computed ${cssProperty} "${value}" for "${cssSelector}" is fully transparent`,
                );
            }

            const linearise = (raw: string) => {
                const channel = Number(raw) / 255;
                return channel <= 0.04045
                    ? channel / 12.92
                    : ((channel + 0.055) / 1.055) ** 2.4;
            };

            const [r, g, b] = [match[1], match[2], match[3]].map(linearise);
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        },
        { cssSelector: selector, cssProperty: property },
    );
}

/**
 * Mean relative luminance (0 = black, 1 = white) of a downscaled capture of
 * the live map canvas. Unlike a style-request count this only passes once the
 * new basemap has actually painted, so drawing that follows happens against
 * the swapped style. Returns NaN on a transient capture failure, which fails
 * either comparison so the poll keeps retrying.
 */
export async function mapCanvasLuminance(page: Page): Promise<number> {
    try {
        const shot = await page.locator(".maplibregl-canvas").screenshot();
        const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

        return await page.evaluate(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();

            const sample = document.createElement("canvas");
            sample.width = 64;
            sample.height = 64;
            const context = sample.getContext("2d");
            if (!context) {
                return Number.NaN;
            }
            context.drawImage(image, 0, 0, sample.width, sample.height);

            const { data } = context.getImageData(0, 0, sample.width, sample.height);
            let total = 0;
            for (let i = 0; i < data.length; i += 4) {
                total +=
                    (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
            }
            return total / (data.length / 4);
        }, dataUrl);
    } catch {
        return Number.NaN;
    }
}

/**
 * Number of distinct quantised colours in a downscaled capture of the map
 * canvas. A blank or uniform canvas (white, or background-only) yields 1-3;
 * a painted map with tiles and labels yields hundreds.
 */
async function mapCanvasColourCount(page: Page): Promise<number> {
    try {
        const shot = await page.locator(".maplibregl-canvas").screenshot();
        const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

        return await page.evaluate(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();

            const sample = document.createElement("canvas");
            sample.width = 160;
            sample.height = 160;
            const context = sample.getContext("2d");
            if (!context) {
                return 0;
            }
            context.drawImage(image, 0, 0, sample.width, sample.height);

            const { data } = context.getImageData(0, 0, sample.width, sample.height);
            const colours = new Set<number>();
            for (let i = 0; i < data.length; i += 4) {
                colours.add(
                    ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4),
                );
            }
            return colours.size;
        }, dataUrl);
    } catch {
        // Transient capture errors must not abort the poll.
        return 0;
    }
}

/**
 * Hard gate for map screenshots: refuses to let a capture proceed until real
 * map tiles have been downloaded AND the canvas actually shows painted map
 * content.
 *
 * Why both signals:
 * - Tile bodies must exist. The default 1280x720 viewport has a 780x650 map;
 *   at zoom 3 that needs 4-6 of MapLibre's 512px tiles, so 4 proves real
 *   coverage without being brittle about edge tiles.
 * - Downloaded is not painted. MapLibre parses tiles in a worker and paints on
 *   later animation frames; probes showed 4 finished tile requests with a
 *   still-blank canvas, and a double `requestAnimationFrame` alone was not
 *   enough under parallel GPU load (a full-suite capture was blank again).
 *   Polling the canvas's own colour diversity is load-independent and gates on
 *   the pixels the screenshot will actually contain.
 *
 * Non-map screens (e.g. the `/#/api/` TypeDoc route) return immediately.
 * A timeout throws loudly.
 *
 * Note this gate proves the live canvas painted; it cannot by itself stop a
 * later full-viewport capture from reading back blank pixels (a Chromium
 * WebGL readback race). `captureScreenshot` validates the captured bytes for
 * that reason.
 */
export async function waitForMapTilesReady(
    page: Page,
    options: { minimumTiles?: number; timeout?: number } = {},
) {
    const minimumTiles = options.minimumTiles ?? 4;
    const timeout = options.timeout ?? 30_000;

    if ((await page.locator("#maplibre-map").count()) === 0) {
        return;
    }

    const tileUrls = mapTileUrlsByPage.get(page) ?? [];
    try {
        await expect
            .poll(() => tileUrls.length, { timeout })
            .toBeGreaterThanOrEqual(minimumTiles);
    } catch (error) {
        throw new Error(
            `Map tiles did not render on ${page.url()}: only ${tileUrls.length} finished tile request(s) within ${timeout}ms (minimum ${minimumTiles}). Refusing to capture a blank map.`,
            { cause: error },
        );
    }

    let lastColourCount = 0;
    try {
        await expect
            .poll(
                async () => {
                    lastColourCount = await mapCanvasColourCount(page);
                    return lastColourCount;
                },
                { timeout },
            )
            .toBeGreaterThan(10);
    } catch (error) {
        throw new Error(
            `Map canvas never painted on ${page.url()}: ${tileUrls.length} finished tile request(s), canvas showed only ${lastColourCount} distinct colour(s) after ${timeout}ms. Refusing to capture a blank map.`,
            { cause: error },
        );
    }

    // Final compositor settle before the capture.
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
}

/**
 * Minimum distinct exact (8-bit) colours expected in an overlay-free band of a
 * painted map capture. Measured across the four committed assets the painted
 * minimum is 139 (dark home) and the blank score is 1, so 32 leaves a wide
 * margin both ways. See `capturedMapColourCount` for why the check uses a band
 * and exact colours rather than the `mapCanvasColourCount` quantisation.
 */
const MINIMUM_PAINTED_COLOURS = 32;

/**
 * Distinct exact (8-bit) colours in an overlay-free band of the map canvas,
 * read back from an already-captured PNG buffer. Returns `null` when the page
 * has no map (e.g. the `/#/api/` TypeDoc route), so validation is skipped
 * there.
 *
 * Why a band, and why exact colours:
 * - The drawing toolbar covers the top ~105px of the map and the attribution
 *   control the bottom ~35px. Sampling the whole map container counts their
 *   antialiased pixels, so a blank map still scores 40+ quantised colours and
 *   a naive ">10 colours" check passes it. The band below the toolbar and
 *   above the attribution contains map pixels only.
 * - Quantising to 4 bits per channel compresses the white basemap until a
 *   painted dark-home band scores exactly 10 distinct colours — the boundary
 *   the live-canvas gate uses to mean "painted". Exact colours keep a wide
 *   margin: blank bands score 1, while the painted committed assets score
 *   139-960.
 *
 * The buffer's pixel scale is derived from `image.width / window.innerWidth` so
 * the band stays correct if the capture pixel ratio ever changes.
 */
async function capturedMapColourCount(page: Page, shot: Buffer): Promise<number | null> {
    const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

    return page.evaluate(async (url) => {
        const mapElement =
            document.querySelector(".maplibregl-canvas") ??
            document.querySelector("#maplibre-map");
        if (!mapElement) {
            return null;
        }

        const image = new Image();
        image.src = url;
        await image.decode();

        const rect = mapElement.getBoundingClientRect();
        const scaleX = image.width / window.innerWidth;
        const scaleY = image.height / window.innerHeight;

        const sx = Math.max(0, Math.round((rect.x + 8) * scaleX));
        const sy = Math.max(0, Math.round((rect.y + 120) * scaleY));
        const sw = Math.max(1, Math.round((rect.width - 16) * scaleX));
        const sh = Math.max(1, Math.round((rect.height - 160) * scaleY));

        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) {
            // Cannot inspect the buffer; treat it as blank rather than risk
            // committing one that cannot be validated.
            return 0;
        }
        context.drawImage(image, 0, 0);

        const { data } = context.getImageData(sx, sy, sw, sh);
        const colours = new Set<number>();
        for (let i = 0; i < data.length; i += 4) {
            colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        return colours.size;
    }, dataUrl);
}

/**
 * Recovery trigger for a blank capture: resize the viewport by one pixel and
 * restore it. MapLibre 6 watches its container with a `ResizeObserver`, so
 * this runs `map.resize()` + a redraw, forcing a fresh composited frame. A
 * synthetic `window` `resize` event does nothing (MapLibre 6 no longer listens
 * for it), and double `requestAnimationFrame` alone was the weakest measured
 * recovery (2 of 9 blanks were still blank after three fast attempts).
 */
async function nudgeMapRepaint(page: Page) {
    const viewport = page.viewportSize();
    if (!viewport) {
        return;
    }

    await page.setViewportSize({ width: viewport.width + 1, height: viewport.height + 1 });
    await page.waitForTimeout(150);
    await page.setViewportSize(viewport);
    await page.waitForTimeout(150);
}

/**
 * Captures a screenshot and writes it to `path` only once the captured bytes
 * prove the map actually painted. Gated on map-tile readiness (see
 * `waitForMapTilesReady`) and validated per attempt:
 *
 * - Chromium can transiently reject `Page.captureScreenshot` while several
 *   headless browsers render WebGL maps in parallel. Those protocol errors are
 *   retried with linear backoff; the rejection window is short but real, and
 *   immediate retries burn all attempts within milliseconds.
 * - Independently of protocol errors, Chromium can return a *successful*
 *   screenshot with blank map pixels (a compositor/readback race under GPU
 *   load; observed as "GPU stall due to ReadPixels" warnings). A blank capture
 *   is therefore never written. Each attempt decodes its own PNG buffer and
 *   counts real painted colours in the map region; a blank one triggers a
 *   `nudgeMapRepaint` so MapLibre redraws, re-runs `waitForMapTilesReady`,
 *   then waits the same bounded backoff (400ms, then 800ms) before retrying.
 *
 * Writing the file only after validation means a failure can never leave a
 * blank asset behind. If every attempt is blank the function throws with the
 * path and the colour count it saw. Non-map screens (no `#maplibre-map`) skip
 * pixel validation. Returns the buffer so callers can attach it to the report.
 */
export async function captureScreenshot(page: Page, path: string): Promise<Buffer> {
    await waitForMapTilesReady(page);

    // Delay after each failed attempt; length + 1 = total attempts.
    const backoffMs = [400, 800];
    let lastColourCount: number | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= backoffMs.length + 1; attempt += 1) {
        if (attempt > 1) {
            await nudgeMapRepaint(page);
            await waitForMapTilesReady(page);
            await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt - 2]));
        }

        try {
            const shot = await page.screenshot();
            const colourCount = await capturedMapColourCount(page, shot);
            if (colourCount === null || colourCount > MINIMUM_PAINTED_COLOURS) {
                // Match `page.screenshot({ path })`: create missing parent
                // directories before writing.
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, shot);
                return shot;
            }
            lastColourCount = colourCount;
        } catch (error) {
            lastError = error;
        }
    }

    if (lastColourCount !== null) {
        const errorNote = lastError ? ` Last capture error: ${String(lastError)}` : "";
        throw new Error(
            `Refusing to write a blank screenshot to ${path}: ${backoffMs.length + 1} capture attempt(s) showed at most ${lastColourCount} distinct colour(s) in the map region (need more than ${MINIMUM_PAINTED_COLOURS}).${errorNote}`,
        );
    }

    throw lastError;
}

export { expect };
