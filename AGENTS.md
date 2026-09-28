## Start Here

Full docs index: [`documentation/README.md`](documentation/README.md).
Project overview: [`README.md`](README.md).

## Gotchas

- Hash routes are `/#/` and `/#/api/`; the API tab is an iframe to the external TypeDoc site.
- Prerender scaffolding is inert — `@preact/preset-vite` defaults `prerender.enabled` to false, so the build emits an empty `#app` shell.
- A hardcoded Protomaps API key lives in `src/routes/home/setup-maplibre.ts`.
- Legacy dead code is not in the build: `src/sw.js`, `src/manifest.json`, `size-plugin.json`, and the Leaflet CSS CDN link in `index.html`.
- The home route persists to `localStorage` under the key `terra-draw`.
- `npm run typecheck` excludes tests and `playwright.config.ts`.
