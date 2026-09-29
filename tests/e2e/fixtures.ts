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

export type ColourProperty = "backgroundColor" | "color" | "borderTopColor";

/**
 * WCAG relative luminance (0 = black, 1 = white) of an element's computed
 * `backgroundColor`, `color` or `borderTopColor`.
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

// Dark-mode chrome invariants. Deliberately loose — the palette values remain
// tuneable, so only "surface is dark" and "text is light" are asserted.
const DARK_LUMINANCE_CEILING = 0.2;
const LIGHT_TEXT_LUMINANCE_FLOOR = 0.7;

/** Dark-chrome invariants shared by every route: dark surfaces, light text. */
export async function expectDarkChrome(page: Page) {
    const bodyBackground = await relativeLuminance(page, "body", "backgroundColor");
    expect(
        bodyBackground,
        "body background luminance under prefers-color-scheme: dark",
    ).toBeLessThan(DARK_LUMINANCE_CEILING);

    const headerBackground = await relativeLuminance(page, "header", "backgroundColor");
    expect(
        headerBackground,
        "header background luminance under prefers-color-scheme: dark",
    ).toBeLessThan(DARK_LUMINANCE_CEILING);

    const bodyText = await relativeLuminance(page, "body", "color");
    expect(bodyText, "body text luminance under prefers-color-scheme: dark").toBeGreaterThan(
        LIGHT_TEXT_LUMINANCE_FLOOR,
    );
}

/**
 * Mean relative luminance (0 = black, 1 = white) of the live map canvas, i.e.
 * the basemap only. Unlike a style-request count this only passes once the new
 * basemap has actually painted, so drawing that follows happens against the
 * swapped style. Returns NaN on a transient capture failure, which fails either
 * comparison so the poll keeps retrying.
 *
 * A screenshot of the `.maplibregl-canvas` element reads the composited page
 * clipped to the canvas box, so DOM overlays painted above it (the drawing
 * toolbar, MapLibre controls) leak their pixels into the value — bright button
 * tokens were measured pushing the dark-home value to 0.2014 while the basemap
 * was fully dark. The sample therefore excludes every pixel covered by a live
 * overlay bounding box (`#maplibre-map`'s children other than the canvas
 * container, plus its `.maplibregl-ctrl` controls), so the result derives from
 * basemap pixels only and no overlay can contribute.
 */
export async function mapCanvasLuminance(page: Page): Promise<number> {
    try {
        const shot = await page.locator(".maplibregl-canvas").screenshot();
        const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

        return await page.evaluate(async (url) => {
            const canvasElement = document.querySelector(".maplibregl-canvas");
            if (!canvasElement) {
                return Number.NaN;
            }

            const image = new Image();
            image.src = url;
            await image.decode();

            const sample = document.createElement("canvas");
            sample.width = image.width;
            sample.height = image.height;
            const context = sample.getContext("2d");
            if (!context) {
                return Number.NaN;
            }
            context.drawImage(image, 0, 0);

            // Overlays painted above the canvas in the capture. Their live
            // bounding boxes are rasterised into a mask so the per-pixel loop
            // below can skip them structurally, whatever their size or count.
            const overlayRects = Array.from(
                document.querySelectorAll(
                    "#maplibre-map > :not(.maplibregl-canvas-container), #maplibre-map .maplibregl-ctrl",
                ),
            )
                .map((element) => element.getBoundingClientRect())
                .filter((rect) => rect.width > 0 && rect.height > 0);

            const canvasRect = canvasElement.getBoundingClientRect();
            // Image pixels per CSS pixel; the capture may not be at ratio 1.
            const scaleX = image.width / Math.max(1, canvasRect.width);
            const scaleY = image.height / Math.max(1, canvasRect.height);

            const mask = document.createElement("canvas");
            mask.width = image.width;
            mask.height = image.height;
            const maskContext = mask.getContext("2d");
            if (!maskContext) {
                return Number.NaN;
            }
            maskContext.fillStyle = "#000";
            const pad = 2;
            for (const rect of overlayRects) {
                maskContext.fillRect(
                    (rect.left - canvasRect.left - pad) * scaleX,
                    (rect.top - canvasRect.top - pad) * scaleY,
                    (rect.width + 2 * pad) * scaleX,
                    (rect.height + 2 * pad) * scaleY,
                );
            }
            const maskData = maskContext.getImageData(
                0,
                0,
                mask.width,
                mask.height,
            ).data;

            const { data } = context.getImageData(0, 0, sample.width, sample.height);
            let total = 0;
            let counted = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (maskData[i + 3] !== 0) {
                    continue;
                }
                total +=
                    (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
                counted += 1;
            }
            return counted > 0 ? total / counted : Number.NaN;
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
 * painted map capture. Measured across the four documentation captures the
 * painted minimum is 139 (dark home) and the blank score is 1, so 32 leaves
 * a wide margin both ways. See `capturedMapColourCount` for why the check
 * uses a band and exact colours rather than the `mapCanvasColourCount`
 * quantisation.
 */
const MINIMUM_PAINTED_COLOURS = 32;

/**
 * Grid used to cross-check a full-page capture against the live map canvas
 * (see `contradictedMapCells`). A compositor-tile-sized defect (the observed
 * one covered half a map) spans many cells, while an eight-by-eight grid keeps
 * flat geography comfortably inside single cells.
 */
const CAPTURE_GRID_COLUMNS = 8;
const CAPTURE_GRID_ROWS = 8;

/**
 * A capture cell is only "contradicted" when it is a single flat colour while
 * the live canvas at the same place shows clearly varied content. The
 * six-colour floor deliberately ignores an antialiased coastline or a single
 * fading label (2-5 colours) — the only legitimate ways a flat cell can differ
 * from the canvas — while a true uncomposited region is varied far beyond it.
 * `MAXIMUM_CONTRADICTED_CELLS` tolerates a couple of stray timing artefacts
 * yet still catches a defect that spans a whole compositor tile.
 */
const MINIMUM_CANVAS_CELL_COLOURS = 6;
const MAXIMUM_CONTRADICTED_CELLS = 2;

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
 * Cross-checks an already-captured full-page PNG against a fresh capture of
 * the live map canvas, cell by cell, to catch a partially composited capture
 * that a single-band colour count cannot see (a half-uniform capture still
 * scores hundreds of colours from its painted half).
 *
 * Why the live canvas, not the PNG alone: a fully composited dark capture
 * legitimately contains large, exactly uniform regions (Protomaps' `black`
 * basemap paints flat `#141414` land and `#333333` water), and the observed
 * uncomposited colour `#2b2b2b` also occurs 609 times in a *good* dark capture
 * — so "is this colour a map colour?" and "does this colour appear elsewhere?"
 * cannot separate a defect from flat geography. The canvas, by contrast, is
 * proven painted by `waitForMapTilesReady`, so a cell that is uniform in the
 * capture while the canvas at the same place is varied can only mean the
 * capture is missing the composited pixels there.
 *
 * False-positive safety:
 * - Only capture cells that are a single flat colour are examined, and only
 *   when the canvas cell is strongly varied. A legitimately flat region is
 *   flat in the canvas too, so it is never flagged; an antialiased boundary
 *   (2-5 colours) is skipped as ambiguous.
 * - Cells touching a toolbar/control overlay are skipped: those are painted
 *   above the canvas in the page capture but absent from the canvas capture.
 * - If the canvas capture itself looks unpainted the comparison retries rather
 *   than flagging, so a canvas readback glitch cannot fail a good capture.
 *
 * Returns `null` when the page has no map canvas (e.g. the `/#/api/` route);
 * otherwise the number of contradicted cells out of those sampled.
 */
async function contradictedMapCells(
    page: Page,
    shot: Buffer,
): Promise<{ contradictedCells: number; sampledCells: number } | null> {
    const canvasLocator = page.locator(".maplibregl-canvas");
    if ((await canvasLocator.count()) === 0) {
        return null;
    }

    // A protocol error here is a transient capture failure; let the caller
    // retry instead of silently skipping validation.
    const canvasShot = await canvasLocator.screenshot();

    const pageUrl = `data:image/png;base64,${shot.toString("base64")}`;
    const canvasUrl = `data:image/png;base64,${canvasShot.toString("base64")}`;

    return page.evaluate(
        async ({ pageUrl, canvasUrl, columns, rows, minimumCellColours, minimumPainted }) => {
            const canvasElement = document.querySelector(".maplibregl-canvas");
            const mapElement = canvasElement ?? document.querySelector("#maplibre-map");
            if (!canvasElement || !mapElement) {
                return null;
            }

            const decode = async (url: string) => {
                const image = new Image();
                image.src = url;
                await image.decode();
                return image;
            };
            const [pageImage, canvasImage] = await Promise.all([
                decode(pageUrl),
                decode(canvasUrl),
            ]);

            // One offscreen canvas per capture, drawn once, so cells can be
            // read back cheaply with `getImageData`.
            const contextFor = (image: HTMLImageElement) => {
                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext("2d");
                if (!context) {
                    return null;
                }
                context.drawImage(image, 0, 0);
                return context;
            };
            const pageContext = contextFor(pageImage);
            const canvasContext = contextFor(canvasImage);
            if (!pageContext || !canvasContext) {
                return null;
            }

            // If the canvas capture is itself blank it cannot be trusted as
            // ground truth; throwing makes the caller retry the whole capture.
            const canvasColours = new Set<number>();
            const canvasData = canvasContext.getImageData(
                0,
                0,
                canvasImage.width,
                canvasImage.height,
            ).data;
            for (let i = 0; i < canvasData.length; i += 4) {
                canvasColours.add(
                    (canvasData[i] << 16) | (canvasData[i + 1] << 8) | canvasData[i + 2],
                );
            }
            if (canvasColours.size <= minimumPainted) {
                throw new Error(
                    `Live canvas capture was blank (${canvasColours.size} colour(s))`,
                );
            }

            const mapRect = mapElement.getBoundingClientRect();
            const canvasRect = canvasElement.getBoundingClientRect();

            // Image pixels per CSS pixel for each capture.
            const pageScaleX = pageImage.width / window.innerWidth;
            const pageScaleY = pageImage.height / window.innerHeight;
            const canvasScaleX = canvasImage.width / Math.max(1, canvasRect.width);
            const canvasScaleY = canvasImage.height / Math.max(1, canvasRect.height);

            // Same overlay-free band `capturedMapColourCount` samples.
            const band = {
                x: mapRect.x + 8,
                y: mapRect.y + 120,
                width: Math.max(1, mapRect.width - 16),
                height: Math.max(1, mapRect.height - 160),
            };

            // Overlays are painted above the canvas in the page capture but are
            // absent from the canvas capture; their cells must be skipped.
            const overlayRects = Array.from(
                document.querySelectorAll(
                    "#maplibre-map > :not(.maplibregl-canvas-container)",
                ),
            ).map((element) => element.getBoundingClientRect());

            const distinctColours = (
                context: CanvasRenderingContext2D,
                image: HTMLImageElement,
                region: { x: number; y: number; width: number; height: number },
                scaleX: number,
                scaleY: number,
            ) => {
                const x = Math.max(0, Math.round(region.x * scaleX));
                const y = Math.max(0, Math.round(region.y * scaleY));
                if (x >= image.width || y >= image.height) {
                    return null;
                }
                const width = Math.min(
                    Math.max(1, Math.round(region.width * scaleX)),
                    image.width - x,
                );
                const height = Math.min(
                    Math.max(1, Math.round(region.height * scaleY)),
                    image.height - y,
                );
                const { data } = context.getImageData(x, y, width, height);
                const colours = new Set<number>();
                for (let i = 0; i < data.length; i += 4) {
                    colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
                }
                return colours;
            };

            const cellWidth = band.width / columns;
            const cellHeight = band.height / rows;
            let sampledCells = 0;
            let contradictedCells = 0;

            for (let row = 0; row < rows; row += 1) {
                for (let column = 0; column < columns; column += 1) {
                    const cell = {
                        x: band.x + column * cellWidth,
                        y: band.y + row * cellHeight,
                        width: cellWidth,
                        height: cellHeight,
                    };

                    const centreX = cell.x + cell.width / 2;
                    const centreY = cell.y + cell.height / 2;
                    const underOverlay = overlayRects.some(
                        (overlay) =>
                            centreX >= overlay.left - 2 &&
                            centreX <= overlay.right + 2 &&
                            centreY >= overlay.top - 2 &&
                            centreY <= overlay.bottom + 2,
                    );
                    // The cell must also lie fully inside the canvas image.
                    const outsideCanvas =
                        cell.x < canvasRect.x ||
                        cell.y < canvasRect.y ||
                        cell.x + cell.width > canvasRect.right ||
                        cell.y + cell.height > canvasRect.bottom;
                    if (underOverlay || outsideCanvas) {
                        continue;
                    }

                    const pageColours = distinctColours(
                        pageContext,
                        pageImage,
                        cell,
                        pageScaleX,
                        pageScaleY,
                    );
                    if (!pageColours || pageColours.size !== 1) {
                        continue;
                    }

                    const canvasCell = {
                        x: (cell.x - canvasRect.x) * canvasScaleX,
                        y: (cell.y - canvasRect.y) * canvasScaleY,
                        width: cell.width * canvasScaleX,
                        height: cell.height * canvasScaleY,
                    };
                    const canvasCellColours = distinctColours(
                        canvasContext,
                        canvasImage,
                        canvasCell,
                        1,
                        1,
                    );
                    if (!canvasCellColours) {
                        continue;
                    }

                    sampledCells += 1;
                    if (canvasCellColours.size >= minimumCellColours) {
                        contradictedCells += 1;
                    }
                }
            }

            return { contradictedCells, sampledCells };
        },
        {
            pageUrl,
            canvasUrl,
            columns: CAPTURE_GRID_COLUMNS,
            rows: CAPTURE_GRID_ROWS,
            minimumCellColours: MINIMUM_CANVAS_CELL_COLOURS,
            minimumPainted: MINIMUM_PAINTED_COLOURS,
        },
    );
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
 *   screenshot with blank or *partially* composited map pixels (a
 *   compositor/readback race under GPU load; observed as "GPU stall due to
 *   ReadPixels" warnings, and once as a half-uniform capture). Neither is ever
 *   written. Each attempt decodes its own PNG buffer, counts real painted
 *   colours in the map region, and cross-checks that region against the live
 *   canvas cell by cell (`contradictedMapCells`); a failing capture triggers a
 *   `nudgeMapRepaint` so MapLibre redraws, re-runs `waitForMapTilesReady`,
 *   then waits the same bounded backoff (400ms, then 800ms) before retrying.
 *
 * Writing the file only after validation means a failure can never leave a
 * blank or partial asset behind. If every attempt fails the function throws
 * with the path and the last colour count it saw. Non-map screens (no
 * `#maplibre-map`) skip pixel validation. Returns the buffer so callers can
 * attach it to the report.
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
            if (typeof colourCount === "number") {
                lastColourCount = colourCount;
            }

            const bandPainted =
                colourCount === null || colourCount > MINIMUM_PAINTED_COLOURS;
            // Only cross-check the canvas once the cheap band check has passed,
            // so an obviously blank capture fails without a second screenshot.
            const integrity = bandPainted ? await contradictedMapCells(page, shot) : null;
            const gridPainted =
                integrity === null ||
                integrity.contradictedCells <= MAXIMUM_CONTRADICTED_CELLS;

            if (bandPainted && gridPainted) {
                // Match `page.screenshot({ path })`: create missing parent
                // directories before writing.
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, shot);
                return shot;
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (lastColourCount !== null) {
        const errorNote = lastError ? ` Last capture error: ${String(lastError)}` : "";
        throw new Error(
            `Refusing to write a blank screenshot to ${path}: ${backoffMs.length + 1} capture attempt(s) did not prove a fully painted map (last band colour count ${lastColourCount}, minimum ${MINIMUM_PAINTED_COLOURS}; a partially composited capture is rejected too).${errorNote}`,
        );
    }

    throw lastError;
}

export { expect };
