---
git_hash: "f9987e09d0fed9b051e1cf713d3e12ca38f4f86d"
modified: "2026-09-28"
---

# Terra Draw Website — Developer Documentation

Developer docs for the official [Terra Draw](https://github.com/JamesLMilner/terra-draw) website ([terradraw.io](https://terradraw.io)): a static Preact site that doubles as a live demo of the library. They deliberately do not cover the Terra Draw API itself — the API tab iframes the TypeDoc site generated in the [terra-draw repository](https://jameslmilner.github.io/terra-draw/modules.html).

## Reading Order

1. [Getting started](1.start.md) — install, scripts, dev server and repo layout.
2. [Architecture](2.architecture.md) — stack, rendering pipeline, routing, styling and tech debt.
3. [Map and drawing](3.map-and-drawing.md) — MapLibre setup, Terra Draw modes, data flow and persistence.
4. [Export and measurement](4.export-and-measurement.md) — Info tab counts and measurements, GeoJSON and FlatGeobuf export.
5. [Testing](5.testing.md) — the Playwright end-to-end suite, fixtures, config and CI wiring.
6. [Deployment](6.deployment.md) — build output, CI jobs, GitHub Pages and runtime CDN dependencies.

## Layout

- [`README.md`](../README.md) — project overview
- [`src/`](../src/) · [`tests/e2e/`](../tests/e2e/) · [`tests/data/`](../tests/data/) · [`.github/workflows/`](../.github/workflows/)

> [!WARNING]
> `docs/` at the repo root is **Vite build output** ([`vite.config.ts:7`](../vite.config.ts) sets `build.outDir: "docs"`), gitignored and wiped on every build. Developer documentation lives in `documentation/` — never edit `docs/` by hand.
