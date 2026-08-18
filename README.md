# Local CSV/Excel to JSON Bulk Data Transformer

> 🚀 **[View Live Demo](https://samithatharanga.github.io/local-csv-json-transformer/)** 
A privacy-first, client-side web application for converting **CSV, XLSX, and XLS** files into JSON. The selected source file is processed in the browser; the application has no backend upload endpoint.

## File structure

```text
local-data-transformer/
├── index.html
├── README.md
└── src/
    ├── core/
    │   └── transformer.js
    ├── infra/
    │   └── parser.js
    └── ui/
        └── uiController.js
```

## Architecture

### `src/core/transformer.js` — Core / Domain

Owns deterministic transformation rules only:

- Validates row collections and transformation settings.
- Builds safe and unique JSON keys from the chosen header row.
- Handles blank rows, blank values, duplicate headers, dates, and non-finite numeric values.
- Converts rows to records in asynchronous chunks so the UI can keep rendering.
- Serializes JSON in chunks and exposes preview helpers.
- Has no DOM, file, network, or SheetJS dependency.

### `src/infra/parser.js` — Infrastructure

Owns file and spreadsheet concerns:

- Accepts `.csv`, `.xlsx`, and `.xls`.
- Rejects empty files and files above the explicit 100 MB browser safety limit.
- Uses the official SheetJS CE browser build (`0.20.3`).
- Parses in a Web Worker when browser policy permits it.
- Falls back to main-thread parsing when Worker/Blob execution is unavailable.
- Returns raw rows and workbook sheet names to the domain/presentation layers.

### `src/ui/uiController.js` — Presentation

Owns browser interaction only:

- Drag/drop and file-input events.
- Worksheet selection.
- Progress and accessible status announcements.
- Dataset metrics and limited previews.
- Copy/download/reset actions.
- A session-only audit trail showing user-visible processing events.
- Error mapping and interface state management.

## Privacy model

The application intentionally has **no server-side processing endpoint**. The source spreadsheet is read from the browser `File` object, parsed locally, transformed locally, and exported locally.

Important nuance: the supplied version loads Tailwind CSS and SheetJS from public CDNs. That means the browser makes normal asset requests to those CDNs when loading the page. The application code does not send the selected spreadsheet to those CDNs.

For a stricter offline / controlled-network deployment, self-host all runtime assets and apply an appropriate Content Security Policy.

## Non-blocking large-file strategy

1. **Parsing:** SheetJS is loaded inside a Web Worker when available. This keeps expensive workbook parsing off the presentation thread.
2. **Transformation:** rows are processed in batches; execution yields between batches using `setTimeout(..., 0)`.
3. **Serialization:** JSON records are serialized in batches and progress is reported to the UI.
4. **Preview:** only the first 25 transformed records are rendered in the `<pre>` element, preventing large output DOM updates.

This design improves responsiveness but cannot remove device memory limits. Very large workbooks may still require a desktop/server ETL workflow.

## ISO 9001-aligned quality practices

This codebase applies software-quality practices that are compatible with an ISO 9001-style quality mindset:

- **Documented responsibilities:** core, infrastructure, and presentation concerns are separated.
- **Input control:** type, size, presence, row shape, header index, and chunk settings are validated.
- **Traceability:** meaningful error codes and a visible session audit log record process states.
- **Controlled output:** duplicate headers are deterministic; invalid dates/non-finite values do not silently produce invalid JSON.
- **Error handling:** expected parser/domain errors are surfaced as actionable UI states; unexpected errors are contained and logged.
- **Maintainability:** business rules are testable without the DOM or SheetJS.

### Certification disclaimer

The project **does not claim ISO 9001 certification**. ISO 9001 certification concerns an audited organizational quality management system. Code can support quality objectives, but code alone cannot make a product or organization certified.

## SEO / GEO / AEO strategy

`index.html` includes:

- A unique, high-intent `<title>` and meta description.
- Search phrases such as **secure data converter**, **client-side CSV parser**, **privacy-first Excel to JSON**, and **offline data transformer** used in natural explanatory copy.
- Semantic `<header>`, `<main>`, `<section>`, `<article>`, and `<footer>` structure.
- Open Graph and Twitter metadata.
- `SoftwareApplication` JSON-LD.
- `FAQPage` JSON-LD that mirrors visible FAQ content.
- Problem/solution text that clearly explains why local transformation matters.
- Descriptive headings that make page intent explicit for traditional search engines and AI answer engines.

### Before deployment: replace domain placeholders

Search and replace:

```text
https://YOUR-DOMAIN.example/
```

with your real canonical production URL, and add a real Open Graph image at:

```text
/og-local-data-transformer.png
```

For strongest technical SEO, also add `robots.txt`, `sitemap.xml`, a favicon set, and performance-tested static assets after the deployment hostname is known.

## Tailwind CDN production caveat

This deliverable uses the Tailwind browser CDN because the requested stack explicitly required **Tailwind CSS via CDN**. Tailwind's official documentation states that the Play/Browser CDN is intended for development, not production.

For a hardened production deployment, keep the same markup but compile Tailwind into a static CSS asset with Tailwind CLI, Vite, or PostCSS. This removes the browser-time Tailwind compiler and improves caching, CSP control, and performance.

## SheetJS deployment hardening

The project pins SheetJS CE `0.20.3` to the official SheetJS CDN. SheetJS recommends vendoring the browser script for general stability and production deployments.

Recommended hardened deployment:

```text
/public/vendor/xlsx.full.min.js
/public/assets/app.css
/index.html
/src/...
```

Then update `index.html` and the worker URL in `src/infra/parser.js` to point to your self-hosted SheetJS file.

## Run locally

Because the app uses ES modules, serve the folder over HTTP instead of opening `index.html` with the `file://` protocol.

### Python

```bash
cd local-data-transformer
python3 -m http.server 8080
```

Open:

```text
http://localhost:8080
```

### Node

```bash
npx serve .
```

## Manual acceptance checks

1. Load a valid CSV and confirm the file name, row count, column count, and local status update.
2. Load an XLSX workbook with multiple sheets and confirm the worksheet selector appears.
3. Change the header-row value and confirm the column metric adjusts.
4. Use duplicate column names and verify deterministic suffixes (`name`, `name_2`, ...).
5. Enable “Normalize keys” and verify spaces/punctuation are converted to underscores.
6. Transform data and confirm only a limited preview is rendered.
7. Copy JSON and download JSON; verify the full output contains all transformed records.
8. Load an unsupported or empty file and confirm a controlled error state appears.
9. Reset and confirm active in-memory workspace state is cleared from the UI.
10. Test keyboard navigation and verify the upload zone works with Enter/Space.

## Security notes

- Source cell values are rendered with `textContent`, not inserted as HTML.
- The tool reads spreadsheet formulas as cell data; it does not execute spreadsheet formulas as browser code.
- File extension checks are a UX/control measure, not a malware scanner.
- A browser-based converter cannot guarantee safety for arbitrary hostile files; keep browsers and dependencies updated.
- For sensitive enterprise deployments, self-host dependencies, configure CSP, perform dependency review, and add automated test coverage.

## License

This project is open-source and available under the [MIT License](LICENSE).
