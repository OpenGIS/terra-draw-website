---
git_hash: "42e22802512abcbb561e83baaada058fc1d9aab1"
modified: "2026-09-28"
---

# Terra Draw Website — Developer Documentation

Developer-focused documentation for the official [Terra Draw](https://github.com/JamesLMilner/terra-draw) website ([terradraw.io](https://terradraw.io)): a static Preact site that doubles as a live, interactive demo of the Terra Draw library.

## Reading Order

1. [Getting started](1.start.md) — prerequisites, install, scripts, dev server, tests and a tour of the top-level layout.
2. [Architecture](2.architecture.md) — stack and dependencies, rendering pipeline, routing, conventions, styling, TypeScript configuration and known tech debt.
3. [Map and drawing](3.map-and-drawing.md) — MapLibre setup, Terra Draw modes and validation, the drawing-to-state data flow, persistence and the toolbar.
4. [Export and measurement](4.export-and-measurement.md) — Info tab counts and measurements, GeoJSON display/copy/download and FlatGeobuf export.
5. [Testing](5.testing.md) — the Playwright smoke suite, configuration, CI wiring and debugging.
6. [Deployment](6.deployment.md) — build output, CI jobs, GitHub Pages deployment, custom domain and runtime CDN dependencies.

## Quick Links

- [Root README](../README.md)
- [Source: `src/`](../src/)
- [Tests: `tests/e2e/`](../tests/e2e/)
- [CI/CD workflows: `.github/workflows/`](../.github/workflows/)

## What This Documentation Covers

- How the site is assembled and rendered, and where the boundaries between components, routes and utils sit.
- How the interactive demo wires MapLibre and Terra Draw together, including persistence and export.
- How the project is tested, built and deployed — `npm test` smoke-tests the production bundle that CI then deploys.

It deliberately does **not** document the Terra Draw library API itself — the site's API tab embeds the external TypeDoc site generated in the [terra-draw repository](https://jameslmilner.github.io/terra-draw/modules.html).

> [!WARNING]
> `docs/` at the repo root is the **Vite build output** (`vite.config.ts` sets `build.outDir: "docs"`), is gitignored and is wiped on every build. This documentation lives in `documentation/` — never edit anything under `docs/` by hand.
