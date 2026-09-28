import { test, expect } from "./fixtures";

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
