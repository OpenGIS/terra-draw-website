## Start Here

Full docs index: [`documentation/README.md`](documentation/README.md).
Project overview: [`README.md`](README.md).

## Gotchas

- Hash routes are `/#/` and `/#/api/`; the API tab is an iframe to the external TypeDoc site.
- Prerender scaffolding is inert — `@preact/preset-vite` defaults `prerender.enabled` to false, so the build emits an empty `#app` shell.
- A hardcoded Protomaps API key lives in `src/routes/home/setup-maplibre.ts`.
- Legacy dead code, not in the build: `src/sw.js`, `src/manifest.json` and `size-plugin.json`. The Leaflet CSS CDN link in `index.html` is a separate case: unused (the map stack is MapLibre) but **shipped**, adding an external CDN request on every load.
- The home route persists to `localStorage` under the key `terra-draw`.
- `npm run typecheck` excludes tests and `playwright.config.ts`.
