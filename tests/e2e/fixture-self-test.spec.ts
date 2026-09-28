import { existsSync, rmSync } from "node:fs";
import { test, expect, captureScreenshot } from "./fixtures";

/**
 * Meta-test: proves the auto-applied console-error fixture really fails a test
 * that logs an error.
 *
 * `test.fail()` marks the test as expected to fail, so when the fixture's
 * teardown error fires the test is reported as an expected failure and the
 * suite still exits 0.
 *
 * We use about:blank (no app navigation) because the teardown guard is the
 * behaviour under test, not the app; this keeps the meta-test fast. We wait for
 * the console event explicitly so the fixture's listener has definitely seen it
 * before teardown runs.
 */
test("console-error fixture fails tests that log a console error", async ({ page }) => {
    test.fail();

    const consoleError = page.waitForEvent(
        "console",
        (message) => message.type() === "error",
    );
    await page.evaluate(() =>
        console.error("intentional console error from fixture self-test"),
    );
    await consoleError;
});

/**
 * Meta-test: proves `captureScreenshot` refuses to write the file when the
 * captured bytes show a blank map, even though the capture call itself
 * "succeeds". The live page is painted; the page's screenshot method is stubbed
 * with a real capture of an empty page, making the blank-readback race
 * deterministic instead of probabilistic. Nothing may be written until the
 * pixels validate.
 */
test("captureScreenshot refuses to write a blank capture", async ({ page }) => {
    const target = ".opencode/tmp/capture-guard.png";

    await page.goto("/");
    await expect(page.locator("#select")).toBeVisible();

    // Build a valid 1x1 white PNG through the 2D canvas API (no compositor
    // involvement), then stub the page's screenshot to return it. A real blank
    // capture would be flaky here for the very readback race under test.
    const blankDataUrl = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        return canvas.toDataURL("image/png");
    });
    const blankBuffer = Buffer.from(blankDataUrl.split(",")[1], "base64");

    const originalScreenshot = page.screenshot.bind(page);
    page.screenshot = (() => Promise.resolve(blankBuffer)) as typeof page.screenshot;

    let fileWrittenAfterFailure = false;
    try {
        await expect(captureScreenshot(page, target)).rejects.toThrow(
            /Refusing to write a blank screenshot/,
        );
        fileWrittenAfterFailure = existsSync(target);
    } finally {
        page.screenshot = originalScreenshot;
        rmSync(target, { force: true });
    }

    expect(fileWrittenAfterFailure, "blank capture must never reach the disk").toBe(false);
});

/**
 * Meta-test: proves the storage-isolation fixture clears app-owned keys on
 * every navigation (and therefore before app scripts run).
 */
test("storage isolation fixture clears app-owned localStorage keys", async ({ page }) => {
    await page.goto("/#/api/");

    await page.evaluate(() => {
        localStorage.setItem("terra-draw", "{}");
        localStorage.setItem("tab", "geojson");
    });

    // The reload re-runs the fixture's init script before the app boots.
    await page.reload();

    const stored = await page.evaluate(() => ({
        terraDraw: localStorage.getItem("terra-draw"),
        tab: localStorage.getItem("tab"),
    }));

    expect(stored).toEqual({ terraDraw: null, tab: null });
});
