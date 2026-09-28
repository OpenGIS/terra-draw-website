---
last_commit: "42e22802512abcbb561e83baaada058fc1d9aab1"
---

# Terra Draw Website

The official [Terra Draw](https://www.github.com/JamesLMilner/terra-draw) website repository, live at [terradraw.io](https://terradraw.io). A static Preact + Vite site that doubles as an interactive demo of the library.

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
| `npm test`          | Run the Playwright smoke test (builds and previews the site) |

## Further Reading

- [Documentation index](documentation/README.md) — getting started, architecture, map internals, export, testing and deployment.

## License

[MIT Licensed](./LICENSE)
