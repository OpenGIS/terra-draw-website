# Terra Draw Website

The official [Terra Draw](https://www.github.com/JamesLMilner/terra-draw) website repository, live at [terradraw.io](https://terradraw.io). A static Preact + Vite site that doubles as an interactive demo of the library.

| Light                                                           | Dark                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| ![Demo in light mode](documentation/screenshots/demo-light.png) | ![Demo in dark mode](documentation/screenshots/demo-dark.png) |

> [!TIP]
> The UI and map basemap follow the browser/OS light/dark preference automatically.

## Requirements

- Node.js 24 (CI pins `24.18.0`)
- npm 11

## Installation

```bash
npm ci
```

## Running Locally

```bash
npm run dev
```

The dev server runs at [http://localhost:5173](http://localhost:5173) over HTTP. Browsers treat `localhost` as a secure context, so the geolocation button works locally.

## Testing

For tests, install the Playwright browser first:

```bash
npx playwright install --with-deps chromium
```

See [`documentation/5.testing.md`](documentation/5.testing.md) for the full testing guide.

## Scripts

| Command             | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `npm run dev`       | Start the Vite dev server at `http://localhost:5173`         |
| `npm run typecheck` | Type-check with `tsc --noEmit`                               |
| `npm run build`     | Build the static site into `docs/` and write `docs/CNAME`    |
| `npm run lint`      | Lint `src/` with ESLint                                      |
| `npm test`          | Run the Playwright test suite (builds and previews the site) |

## Docs

- [Start **here**](documentation/README.md).

## License

[MIT Licensed](./LICENSE)
