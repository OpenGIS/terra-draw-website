import { mkdirSync } from "node:fs";
import {
    test,
    expect,
    captureScreenshot,
    mapCanvasLuminance,
    relativeLuminance,
    waitForMapTilesReady,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Automatic light/dark theming contract.
 *
 * The app follows `prefers-color-scheme` with no UI toggle. Everything is
 * asserted through public interfaces (computed styles, network requests,
 * screenshots), never app internals:
 *
 * - Light-palette guards pin the established palette: exact computed colours
 *   and unfiltered header marks.
 * - Dark chrome invariants assert dark surfaces and light text across routes
 *   without pinning exact dark values.
 * - Header marks invert under the dark scheme.
 * - The dark basemap loads on first load and swaps live when the scheme
 *   changes, with drawing still working after the swap.
 * - The committed README dark capture is written to
 *   documentation/screenshots/home-dark.png; the remaining dark evidence for
 *   the API docs route lands in .opencode/tmp/dark-mode/ (gitignored). All
 *   captures are attached to the Playwright report.
 *
 * All ten tests pass against the shipped build; nothing here is skipped or
 * marked fixme.
 */

const LOGO = 'header img[alt="Terra Draw Logo"]';
const GITHUB_LOGO = 'header img[alt="GitHub Logo"]';

// Exact light values shipped today. These must survive byte-identically.
const LIGHT_BACKGROUND = "rgb(250, 250, 250)";
const LIGHT_HEADER_BACKGROUND = "rgb(253, 253, 253)";
const LIGHT_TEXT = "rgb(68, 68, 68)";

// Dark-mode invariants. Deliberately loose — the palette values remain
// tuneable, so only "surface is dark" and "text is light" are asserted.
const DARK_LUMINANCE_CEILING = 0.2;
const LIGHT_TEXT_LUMINANCE_FLOOR = 0.7;

// Any Protomaps style JSON, used to observe which basemap variant loads.
const PROTOMAPS_STYLE_REQUEST = /styles\/v3\/[a-z-]+\.json/;
// The dark style is Protomaps `styles/v3/black.json`, the counterpart of
// white.json; the (black|dark) matcher stays resilient to a rename.
const DARK_BASEMAP_STYLE_REQUEST = /styles\/v3\/(black|dark)\.json/;
const LIGHT_BASEMAP_STYLE_REQUEST = /styles\/v3\/white\.json/;

const DARK_EVIDENCE_DIR = ".opencode/tmp/dark-mode";
const HOME_DARK_SCREENSHOT = "documentation/screenshots/home-dark.png";

// Drawing positions (px offsets from #maplibre-map's top-left, mirroring
// tests/e2e/drawing.spec.ts) kept clear of the toolbar rows and the
// attribution control.
const POLYGON_VERTICES = [
    { x: 220, y: 300 },
    { x: 320, y: 380 },
    { x: 420, y: 300 },
];
const POINT_POSITION = { x: 500, y: 420 };
const MARKER_POSITION = { x: 240, y: 460 };

// Loose mean-luminance gates for the live map canvas. A style request count
// only proves the fetch started; these prove the new basemap actually painted
// (readiness gates, not palette assertions — margins are deliberately wide).
const DARK_CANVAS_LUMINANCE_CEILING = 0.2;
const LIGHT_CANVAS_LUMINANCE_FLOOR = 0.5;

type StoredFeature = {
    geometry: { type: string };
    properties: { mode: string };
};

/** Dark-chrome invariants shared by every route: dark surfaces, light text. */
async function expectDarkChrome(page: Page) {
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
 * Records every Protomaps style request from before navigation, so initial
 * loads are caught, and exposes a per-pattern count for polling.
 */
function collectStyleRequests(page: Page) {
    const styleUrls: string[] = [];

    page.on("request", (request) => {
        if (PROTOMAPS_STYLE_REQUEST.test(request.url())) {
            styleUrls.push(request.url());
        }
    });

    return {
        matching(pattern: RegExp) {
            return styleUrls.filter((url) => pattern.test(url)).length;
        },
    };
}

/** Clicks a point on the real map canvas, mirroring tests/e2e/drawing.spec.ts. */
async function clickMap(page: Page, point: { x: number; y: number }) {
    const box = await page.locator("#maplibre-map").boundingBox();
    if (!box) {
        throw new Error("Map container #maplibre-map has no bounding box");
    }
    await page.mouse.click(box.x + point.x, box.y + point.y);
}

/** A count badge's value span, found via its label span's sibling. */
function badgeValue(page: Page, label: string) {
    return page
        .locator("#sidepanel")
        .getByText(label, { exact: true })
        .locator("xpath=following-sibling::*[1]");
}

/**
 * Features persisted by the app. The store writes a raw feature array, but a
 * FeatureCollection wrapper is tolerated so the assertion tracks the drawn
 * features rather than the exact serialisation shape.
 */
async function readStoredFeatures(page: Page): Promise<StoredFeature[]> {
    const raw = await page.evaluate(() => localStorage.getItem("terra-draw"));
    if (!raw) {
        return [];
    }

    const parsed = JSON.parse(raw) as
        | StoredFeature[]
        | { features: StoredFeature[] };

    return Array.isArray(parsed) ? parsed : parsed.features;
}

test.describe("light colour scheme (default)", () => {
    test.use({ colorScheme: "light" });

    test("keeps the established light palette", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator("header")).toBeVisible();

        await expect(page.locator("body")).toHaveCSS("background-color", LIGHT_BACKGROUND);
        await expect(page.locator("header")).toHaveCSS(
            "background-color",
            LIGHT_HEADER_BACKGROUND,
        );
        await expect(page.locator("body")).toHaveCSS("color", LIGHT_TEXT);
    });

    test("renders the logo and GitHub marks without a filter", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator(LOGO)).toHaveCSS("filter", "none");
        await expect(page.locator(GITHUB_LOGO)).toHaveCSS("filter", "none");
    });
});

test.describe("dark colour scheme", () => {
    test.use({ colorScheme: "dark" });

    test("paints the page chrome dark on the home route", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator("#select")).toBeVisible();

        await expectDarkChrome(page);
    });

    test("paints the page chrome dark on the API docs route", async ({ page }) => {
        await page.goto("/#/api/");
        await expect(page.locator("iframe")).toBeVisible();

        // The TypeDoc iframe also renders dark because `color-scheme: light
        // dark` propagates into the frame; only the page chrome is asserted here.
        await expectDarkChrome(page);
    });

    test("inverts the logo and GitHub marks", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator(LOGO)).toHaveCSS("filter", /invert/);
        await expect(page.locator(GITHUB_LOGO)).toHaveCSS("filter", /invert/);
    });

    test("requests the dark basemap style on first load", async ({ page }) => {
        const styleRequests = collectStyleRequests(page);

        await page.goto("/");
        await expect(page.locator("#select")).toBeVisible();

        await expect
            .poll(() => styleRequests.matching(DARK_BASEMAP_STYLE_REQUEST), {
                message: "expected a dark basemap style request on initial dark-scheme load",
            })
            .toBeGreaterThan(0);
    });

    test("captures the README dark home capture", async ({ page }, testInfo) => {
        await page.goto("/");
        await expect(page.locator("#select")).toBeVisible();
        await expectDarkChrome(page);
        await waitForMapTilesReady(page);

        const screenshot = await captureScreenshot(page, HOME_DARK_SCREENSHOT);
        await testInfo.attach("home-dark", { body: screenshot, contentType: "image/png" });
    });

    test("captures dark-mode evidence for the API docs route", async ({ page }, testInfo) => {
        mkdirSync(DARK_EVIDENCE_DIR, { recursive: true });

        await page.goto("/#/api/");
        await expect(page.locator("iframe")).toBeVisible();
        await expectDarkChrome(page);

        const screenshot = await captureScreenshot(
            page,
            `${DARK_EVIDENCE_DIR}/api-docs-dark.png`,
        );
        await testInfo.attach("dark-api-docs", {
            body: screenshot,
            contentType: "image/png",
        });
    });
});

test.describe("colour scheme switching", () => {
    // Start explicitly light so that emulateMedia("dark") is a real change and
    // fires the app's matchMedia listener.
    test.use({ colorScheme: "light" });

    test("swaps the basemap style when the colour scheme changes mid-session", async ({
        page,
    }) => {
        const styleRequests = collectStyleRequests(page);

        await page.goto("/");
        await expect(page.locator("#select")).toBeVisible();

        await expect
            .poll(() => styleRequests.matching(LIGHT_BASEMAP_STYLE_REQUEST), {
                message: "expected the light basemap style to load before switching schemes",
            })
            .toBeGreaterThan(0);
        const lightLoadsBeforeDark = styleRequests.matching(LIGHT_BASEMAP_STYLE_REQUEST);

        await page.emulateMedia({ colorScheme: "dark" });
        await expect
            .poll(() => styleRequests.matching(DARK_BASEMAP_STYLE_REQUEST), {
                message:
                    "expected a dark basemap style request after switching to the dark scheme",
            })
            .toBeGreaterThan(0);

        // Reverse switch: back to light must load the white style again.
        await page.emulateMedia({ colorScheme: "light" });
        await expect
            .poll(() => styleRequests.matching(LIGHT_BASEMAP_STYLE_REQUEST), {
                message:
                    "expected the light basemap style to load again after switching back",
            })
            .toBeGreaterThan(lightLoadsBeforeDark);
    });

    test("keeps drawing working across a live colour-scheme swap", async ({ page }) => {
        // Three screenshot-gated waits (initial tiles + one per style swap)
        // run close to the 30s default when the suite is parallel; give this
        // test headroom without changing any other test's budget.
        test.setTimeout(60_000);

        const styleRequests = collectStyleRequests(page);

        await page.goto("/");
        await expect(page.locator("#select")).toBeVisible();
        await waitForMapTilesReady(page);

        await expect
            .poll(() => styleRequests.matching(LIGHT_BASEMAP_STYLE_REQUEST), {
                message: "expected the light basemap style to load before switching schemes",
            })
            .toBeGreaterThan(0);
        const lightLoadsBeforeDark = styleRequests.matching(LIGHT_BASEMAP_STYLE_REQUEST);

        await page.emulateMedia({ colorScheme: "dark" });
        await expect
            .poll(() => styleRequests.matching(DARK_BASEMAP_STYLE_REQUEST), {
                message: "expected a dark basemap style request after switching schemes",
            })
            .toBeGreaterThan(0);
        // Wait for the swap to paint so the drawing below really happens
        // against the new style. If td-* sources/layers are not carried over,
        // the adapter's getSource(...).setData throws and the console-error
        // fixture fails the test.
        await expect
            .poll(() => mapCanvasLuminance(page), {
                timeout: 15_000,
                message: "expected the dark basemap to paint after the scheme swap",
            })
            .toBeLessThan(DARK_CANVAS_LUMINANCE_CEILING);

        // Polygon exercises the fill + outline line layers.
        await page.locator("#polygon").click();
        await expect(page.locator("#polygon")).toHaveClass(/active/);
        for (const vertex of POLYGON_VERTICES) {
            await clickMap(page, vertex);
        }
        await page.keyboard.press("Enter");

        await expect(badgeValue(page, "Polygons")).toHaveText("1");
        await expect(badgeValue(page, "Total")).toHaveText("1");

        // Point mirrors drawing.spec.ts; marker exercises the image-dependent
        // td-point-marker symbol layer (markerId icon, not style JSON).
        await page.locator("#point").click();
        await expect(page.locator("#point")).toHaveClass(/active/);
        await clickMap(page, POINT_POSITION);

        await expect(badgeValue(page, "Points")).toHaveText("1");
        await expect(badgeValue(page, "Total")).toHaveText("2");

        await page.locator("#marker").click();
        await expect(page.locator("#marker")).toHaveClass(/active/);
        await clickMap(page, MARKER_POSITION);

        await expect(badgeValue(page, "Points")).toHaveText("2");
        await expect(badgeValue(page, "Total")).toHaveText("3");

        const afterDarkSwap = await readStoredFeatures(page);
        expect(afterDarkSwap).toHaveLength(3);
        expect(afterDarkSwap.map((feature) => feature.properties.mode)).toEqual(
            expect.arrayContaining(["polygon", "point", "marker"]),
        );

        // Reverse swap: the features must survive the second style change.
        await page.emulateMedia({ colorScheme: "light" });
        await expect
            .poll(() => styleRequests.matching(LIGHT_BASEMAP_STYLE_REQUEST), {
                message: "expected the light basemap style to load again after switching back",
            })
            .toBeGreaterThan(lightLoadsBeforeDark);
        await expect
            .poll(() => mapCanvasLuminance(page), {
                timeout: 15_000,
                message: "expected the light basemap to paint again after switching back",
            })
            .toBeGreaterThan(LIGHT_CANVAS_LUMINANCE_FLOOR);

        await expect(badgeValue(page, "Polygons")).toHaveText("1");
        await expect(badgeValue(page, "Points")).toHaveText("2");
        await expect(badgeValue(page, "Total")).toHaveText("3");

        const afterLightSwap = await readStoredFeatures(page);
        expect(afterLightSwap).toHaveLength(3);
        expect(afterLightSwap.map((feature) => feature.properties.mode)).toEqual(
            expect.arrayContaining(["polygon", "point", "marker"]),
        );
    });
});
