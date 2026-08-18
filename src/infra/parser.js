/**
 * Infrastructure layer: file validation and spreadsheet parsing.
 *
 * Parsing is delegated to a Web Worker when available so SheetJS work does not
 * block the presentation thread. The worker receives the File object directly;
 * data remains inside the user's browser process and is never uploaded.
 */

export class ParserError extends Error {
  constructor(message, code = 'PARSER_ERROR', details = {}) {
    super(message);
    this.name = 'ParserError';
    this.code = code;
    this.details = details;
  }
}

const SHEETJS_CDN = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['csv', 'xlsx', 'xls']);

function extensionOf(fileName = '') {
  const segments = fileName.toLowerCase().split('.');
  return segments.length > 1 ? segments.pop() : '';
}

export function validateInputFile(file) {
  if (!(file instanceof File)) {
    throw new ParserError('Choose a CSV or Excel file before continuing.', 'NO_FILE');
  }

  const extension = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new ParserError('Unsupported file type. Use .csv, .xlsx, or .xls.', 'UNSUPPORTED_FILE', { extension });
  }

  if (file.size === 0) {
    throw new ParserError('The selected file is empty.', 'EMPTY_FILE');
  }

  if (file.size > MAX_FILE_BYTES) {
    throw new ParserError('This file exceeds the 100 MB browser safety limit.', 'FILE_TOO_LARGE', {
      size: file.size,
      maxBytes: MAX_FILE_BYTES,
    });
  }

  return { extension, size: file.size };
}

function workerSource() {
  return `
    importScripts(${JSON.stringify(SHEETJS_CDN)});

    function toSerializable(value) {
      if (value instanceof Date) return value.toISOString();
      return value;
    }

    self.onmessage = async (event) => {
      const { file, requestedSheet } = event.data;
      const startedAt = performance.now();

      try {
        if (!file || typeof file.arrayBuffer !== 'function') {
          throw new Error('Worker did not receive a readable file.');
        }

        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, {
          type: 'array',
          dense: true,
          cellDates: true,
          raw: true,
        });

        const sheetNames = workbook.SheetNames || [];
        if (!sheetNames.length) throw new Error('No worksheets were found in the file.');

        const selectedSheet = requestedSheet && sheetNames.includes(requestedSheet)
          ? requestedSheet
          : sheetNames[0];

        const worksheet = workbook.Sheets[selectedSheet];
        const rows = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,
          defval: null,
          raw: true,
          blankrows: false,
        }).map((row) => row.map(toSerializable));

        self.postMessage({
          ok: true,
          sheetNames,
          selectedSheet,
          rows,
          parseMs: Math.round((performance.now() - startedAt) * 10) / 10,
          sheetJsVersion: XLSX.version,
        });
      } catch (error) {
        self.postMessage({
          ok: false,
          message: error && error.message ? error.message : 'Spreadsheet parsing failed.',
        });
      }
    };
  `;
}

async function parseOnMainThread(file, requestedSheet) {
  const XLSX = globalThis.XLSX;
  if (!XLSX) {
    throw new ParserError('SheetJS failed to load. Check your internet connection and reload.', 'SHEETJS_UNAVAILABLE');
  }

  const startedAt = performance.now();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', dense: true, cellDates: true, raw: true });
  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) throw new ParserError('No worksheets were found in the file.', 'NO_SHEETS');

  const selectedSheet = requestedSheet && sheetNames.includes(requestedSheet) ? requestedSheet : sheetNames[0];
  const worksheet = workbook.Sheets[selectedSheet];
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: false,
  }).map((row) => row.map((value) => (value instanceof Date ? value.toISOString() : value)));

  return {
    sheetNames,
    selectedSheet,
    rows,
    parseMs: Math.round((performance.now() - startedAt) * 10) / 10,
    sheetJsVersion: XLSX.version,
    workerUsed: false,
  };
}

export class SpreadsheetParser {
  constructor({ preferWorker = true } = {}) {
    this.preferWorker = preferWorker;
    this.lastFile = null;
  }

  async parse(file, requestedSheet = null) {
    validateInputFile(file);
    this.lastFile = file;

    if (!this.preferWorker || typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      return parseOnMainThread(file, requestedSheet);
    }

    let workerUrl;
    let worker;

    try {
      const blob = new Blob([workerSource()], { type: 'text/javascript' });
      workerUrl = URL.createObjectURL(blob);
      worker = new Worker(workerUrl);

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new ParserError('Parsing timed out. Try a smaller file or reload the page.', 'PARSE_TIMEOUT'));
        }, 120000);

        worker.onmessage = (event) => {
          clearTimeout(timeout);
          const payload = event.data || {};
          if (!payload.ok) {
            reject(new ParserError(payload.message || 'Spreadsheet parsing failed.', 'WORKER_PARSE_FAILED'));
            return;
          }
          resolve({ ...payload, workerUsed: true });
        };

        worker.onerror = (event) => {
          clearTimeout(timeout);
          reject(new ParserError(event.message || 'The parser worker crashed.', 'WORKER_ERROR'));
        };

        worker.postMessage({ file, requestedSheet });
      });

      return result;
    } catch (error) {
      // A strict fallback keeps the tool usable if CSP/browser policy blocks Blob workers.
      if (error instanceof ParserError && ['PARSE_TIMEOUT', 'WORKER_PARSE_FAILED'].includes(error.code)) {
        throw error;
      }
      return parseOnMainThread(file, requestedSheet);
    } finally {
      if (worker) worker.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
    }
  }

  async reparseSheet(sheetName) {
    if (!this.lastFile) {
      throw new ParserError('No file is loaded.', 'NO_CACHED_FILE');
    }
    return this.parse(this.lastFile, sheetName);
  }
}

export const parserLimits = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  supportedExtensions: [...SUPPORTED_EXTENSIONS],
  sheetJsCdn: SHEETJS_CDN,
});
