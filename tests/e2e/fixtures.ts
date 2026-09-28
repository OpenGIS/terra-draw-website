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
 * A timeout throws loudly rather than silently committing a blank asset.
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
 * Captures a screenshot, gated on map-tile readiness (see
 * `waitForMapTilesReady`) and with a bounded immediate retry. Chromium can
 * transiently reject `Page.captureScreenshot` while several headless browsers
 * render WebGL maps in parallel; retrying only the evidence capture keeps the
 * committed asset safe (a failed capture writes no file) without weakening any
 * assertion.
 */
export async function captureScreenshot(page: Page, path: string) {
    await waitForMapTilesReady(page);

    for (let attempt = 1; ; attempt += 1) {
        try {
            return await page.screenshot({ path });
        } catch (error) {
            if (attempt >= 3) {
                throw error;
            }
        }
    }
}

export { expect };
