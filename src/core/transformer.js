/**
 * Domain layer: pure transformation and validation logic.
 *
 * This module deliberately has no DOM, network, file-system, or SheetJS dependency.
 * Keeping transformation rules isolated makes them testable, traceable, and reusable.
 */

export class TransformerError extends Error {
  constructor(message, code = 'TRANSFORMER_ERROR', details = {}) {
    super(message);
    this.name = 'TransformerError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_OPTIONS = Object.freeze({
  headerRowIndex: 0,
  trimHeaders: true,
  normalizeHeaders: false,
  skipEmptyRows: true,
  omitEmptyValues: false,
  emptyValue: null,
  chunkSize: 2000,
});

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function sanitizeHeaderCandidate(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function toSafeKey(value) {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_$]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_') || 'field';
}

function ensureUniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((header, index) => {
    const base = header || `column_${index + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function normalizeCell(value, options) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? options.emptyValue : trimmed;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? options.emptyValue : value.toISOString();
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return options.emptyValue;
  }

  return value === undefined ? options.emptyValue : value;
}

function rowIsEmpty(row) {
  return !Array.isArray(row) || row.every(isBlank);
}

function validateRows(rawRows) {
  if (!Array.isArray(rawRows)) {
    throw new TransformerError('Parser output must be an array of rows.', 'INVALID_ROWS');
  }

  if (rawRows.length === 0) {
    throw new TransformerError('The selected sheet does not contain any rows.', 'EMPTY_DATASET');
  }

  if (!rawRows.some(Array.isArray)) {
    throw new TransformerError('No tabular rows were detected in the selected sheet.', 'NO_TABULAR_DATA');
  }
}

function validateOptions(options) {
  if (!Number.isInteger(options.headerRowIndex) || options.headerRowIndex < 0) {
    throw new TransformerError('Header row must be a non-negative whole number.', 'INVALID_HEADER_ROW');
  }

  if (!Number.isInteger(options.chunkSize) || options.chunkSize < 100 || options.chunkSize > 10000) {
    throw new TransformerError('Chunk size must be between 100 and 10,000 rows.', 'INVALID_CHUNK_SIZE');
  }
}

/**
 * Builds safe, unique JSON object keys from a spreadsheet header row.
 */
export function buildHeaders(rawRows, userOptions = {}) {
  validateRows(rawRows);
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  validateOptions(options);

  if (options.headerRowIndex >= rawRows.length) {
    throw new TransformerError(
      `Header row ${options.headerRowIndex + 1} is outside the dataset.`,
      'HEADER_OUT_OF_RANGE',
      { rowCount: rawRows.length },
    );
  }

  const source = Array.isArray(rawRows[options.headerRowIndex]) ? rawRows[options.headerRowIndex] : [];
  const mapped = source.map((value, index) => {
    let header = sanitizeHeaderCandidate(value);
    if (!header) header = `column_${index + 1}`;
    if (options.trimHeaders) header = header.trim();
    if (options.normalizeHeaders) header = toSafeKey(header);
    return header;
  });

  if (mapped.length === 0) {
    throw new TransformerError('The selected header row is empty.', 'EMPTY_HEADER_ROW');
  }

  return ensureUniqueHeaders(mapped);
}

/**
 * Converts parsed row arrays into records without infrastructure dependencies.
 * It yields control to the browser between chunks to keep interactions responsive.
 */
export async function transformRowsInChunks(rawRows, userOptions = {}, onProgress = () => {}) {
  validateRows(rawRows);
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  validateOptions(options);

  const headers = buildHeaders(rawRows, options);
  const startIndex = options.headerRowIndex + 1;
  const sourceRows = rawRows.slice(startIndex);
  const records = [];
  let skippedRows = 0;
  let emptyCellsOmitted = 0;

  for (let offset = 0; offset < sourceRows.length; offset += options.chunkSize) {
    const chunk = sourceRows.slice(offset, offset + options.chunkSize);

    for (const row of chunk) {
      if (options.skipEmptyRows && rowIsEmpty(row)) {
        skippedRows += 1;
        continue;
      }

      const record = {};
      for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
        const key = headers[columnIndex];
        const value = normalizeCell(Array.isArray(row) ? row[columnIndex] : undefined, options);

        if (options.omitEmptyValues && isBlank(value)) {
          emptyCellsOmitted += 1;
          continue;
        }

        record[key] = value;
      }
      records.push(record);
    }

    const processed = Math.min(offset + chunk.length, sourceRows.length);
    onProgress({
      phase: 'transform',
      processed,
      total: sourceRows.length,
      percent: sourceRows.length ? Math.round((processed / sourceRows.length) * 100) : 100,
    });

    // Yield to rendering and input handling.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    records,
    headers,
    stats: {
      sourceRows: sourceRows.length,
      outputRows: records.length,
      skippedRows,
      columns: headers.length,
      emptyCellsOmitted,
    },
  };
}

/**
 * Asynchronously serializes records in chunks to reduce long main-thread blocks.
 */
export async function serializeRecords(records, { pretty = true, chunkSize = 1000 } = {}, onProgress = () => {}) {
  if (!Array.isArray(records)) {
    throw new TransformerError('Output records must be an array.', 'INVALID_RECORDS');
  }

  if (!Number.isInteger(chunkSize) || chunkSize < 100 || chunkSize > 5000) {
    throw new TransformerError('Serialization chunk size must be between 100 and 5,000.', 'INVALID_SERIALIZE_CHUNK');
  }

  if (records.length === 0) return '[]';

  const chunks = [];
  for (let offset = 0; offset < records.length; offset += chunkSize) {
    const current = records.slice(offset, offset + chunkSize);
    const serialized = current.map((record) => JSON.stringify(record, null, pretty ? 2 : 0));
    chunks.push(serialized);

    const processed = Math.min(offset + current.length, records.length);
    onProgress({
      phase: 'serialize',
      processed,
      total: records.length,
      percent: Math.round((processed / records.length) * 100),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (!pretty) {
    return `[${chunks.flat().join(',')}]`;
  }

  const indented = chunks
    .flat()
    .map((recordText) => recordText.split('\n').map((line) => `  ${line}`).join('\n'))
    .join(',\n');

  return `[\n${indented}\n]`;
}

export function createPreview(records, maxRows = 25) {
  if (!Array.isArray(records)) return [];
  const safeLimit = Math.min(Math.max(Number(maxRows) || 25, 1), 100);
  return records.slice(0, safeLimit);
}
