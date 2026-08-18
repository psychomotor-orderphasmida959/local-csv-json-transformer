/**
 * Presentation layer: DOM state, user interactions, accessibility, audit states.
 * No parsing rules or transformation business logic live in this module.
 */

import { SpreadsheetParser, ParserError } from '../infra/parser.js';
import {
  TransformerError,
  buildHeaders,
  createPreview,
  serializeRecords,
  transformRowsInChunks,
} from '../core/transformer.js';

const parser = new SpreadsheetParser({ preferWorker: true });

const state = {
  file: null,
  rawRows: [],
  sheetNames: [],
  selectedSheet: null,
  records: [],
  jsonText: '',
  parseMeta: null,
  audit: [],
};

const elements = {};

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required UI element #${id} was not found.`);
  return element;
}

function cacheElements() {
  [
    'file-input', 'drop-zone', 'file-name', 'file-meta', 'sheet-select', 'header-row',
    'trim-headers', 'normalize-headers', 'skip-empty-rows', 'omit-empty-values',
    'pretty-json', 'transform-btn', 'copy-btn', 'download-btn', 'reset-btn',
    'status-panel', 'status-title', 'status-message', 'progress-wrap', 'progress-bar',
    'progress-label', 'preview-output', 'preview-note', 'metric-rows', 'metric-columns',
    'metric-size', 'metric-time', 'audit-log', 'sheet-control', 'tool-actions',
  ].forEach((id) => { elements[id] = byId(id); });
}

function bytesToReadable(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function announce(message) {
  elements['status-message'].textContent = message;
}

function setStatus(kind, title, message) {
  const panel = elements['status-panel'];
  panel.dataset.state = kind;
  elements['status-title'].textContent = title;
  announce(message);
}

function setBusy(isBusy) {
  elements['transform-btn'].disabled = isBusy || !state.rawRows.length;
  elements['reset-btn'].disabled = isBusy;
  elements['sheet-select'].disabled = isBusy || state.sheetNames.length < 2;
  elements['file-input'].disabled = isBusy;
  document.body.classList.toggle('is-processing', isBusy);
}

function setProgress(percent = 0, label = '') {
  const normalized = Math.min(Math.max(Number(percent) || 0, 0), 100);
  elements['progress-wrap'].classList.remove('hidden');
  elements['progress-bar'].style.width = `${normalized}%`;
  elements['progress-bar'].setAttribute('aria-valuenow', String(normalized));
  elements['progress-label'].textContent = label || `${normalized}%`;
}

function hideProgress() {
  elements['progress-wrap'].classList.add('hidden');
  elements['progress-bar'].style.width = '0%';
  elements['progress-bar'].setAttribute('aria-valuenow', '0');
}

function addAudit(level, action, detail) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    action,
    detail,
  };
  state.audit.unshift(entry);
  state.audit = state.audit.slice(0, 12);
  renderAudit();
}

function renderAudit() {
  elements['audit-log'].replaceChildren();
  if (!state.audit.length) {
    const li = document.createElement('li');
    li.className = 'text-sm text-slate-500';
    li.textContent = 'No processing events yet.';
    elements['audit-log'].append(li);
    return;
  }

  state.audit.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'audit-item';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-3';

    const action = document.createElement('span');
    action.className = 'font-medium text-slate-800';
    action.textContent = entry.action;

    const time = document.createElement('time');
    time.className = 'text-xs text-slate-400';
    time.dateTime = entry.timestamp;
    time.textContent = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const detail = document.createElement('p');
    detail.className = 'mt-1 text-xs leading-5 text-slate-500';
    detail.textContent = entry.detail;

    header.append(action, time);
    li.append(header, detail);
    elements['audit-log'].append(li);
  });
}

function renderSheetOptions(sheetNames, selectedSheet) {
  const select = elements['sheet-select'];
  select.replaceChildren();
  sheetNames.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    option.selected = name === selectedSheet;
    select.append(option);
  });

  elements['sheet-control'].classList.toggle('hidden', sheetNames.length <= 1);
  select.disabled = sheetNames.length <= 1;
}

function updateMetrics() {
  const dataRows = Math.max(state.rawRows.length - 1, 0);
  let columns = 0;
  try {
    columns = state.rawRows.length ? buildHeaders(state.rawRows, { headerRowIndex: Math.max(Number(elements['header-row'].value) - 1, 0) }).length : 0;
  } catch {
    columns = 0;
  }

  elements['metric-rows'].textContent = dataRows ? dataRows.toLocaleString() : '0';
  elements['metric-columns'].textContent = columns ? columns.toLocaleString() : '0';
  elements['metric-size'].textContent = state.file ? bytesToReadable(state.file.size) : '—';
  elements['metric-time'].textContent = state.parseMeta ? `${state.parseMeta.parseMs} ms` : '—';
}

function renderRawPreview() {
  if (!state.rawRows.length) {
    elements['preview-output'].textContent = '[\n  // Your JSON preview will appear here\n]';
    elements['preview-note'].textContent = 'Preview is limited to keep the interface fast.';
    return;
  }

  const sample = state.rawRows.slice(0, 8);
  elements['preview-output'].textContent = JSON.stringify(sample, null, 2);
  elements['preview-note'].textContent = 'Raw parsed rows shown. Click “Transform to JSON” to create object records.';
}

function renderJsonPreview() {
  const preview = createPreview(state.records, 25);
  elements['preview-output'].textContent = JSON.stringify(preview, null, 2);
  const remaining = Math.max(state.records.length - preview.length, 0);
  elements['preview-note'].textContent = remaining
    ? `Showing 25 of ${state.records.length.toLocaleString()} records. ${remaining.toLocaleString()} more are included in copy/download output.`
    : `Showing all ${state.records.length.toLocaleString()} transformed records.`;
}

function revokeDownloadUrl(anchor) {
  setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
}

function suggestedDownloadName() {
  const base = state.file?.name?.replace(/\.(csv|xlsx|xls)$/i, '') || 'transformed-data';
  const sheet = state.selectedSheet && state.sheetNames.length > 1
    ? `-${state.selectedSheet.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '')}`
    : '';
  return `${base}${sheet}.json`;
}

function readOptions() {
  const headerRow = Number(elements['header-row'].value);
  if (!Number.isInteger(headerRow) || headerRow < 1) {
    throw new TransformerError('Header row must be 1 or greater.', 'INVALID_HEADER_ROW_UI');
  }

  return {
    headerRowIndex: headerRow - 1,
    trimHeaders: elements['trim-headers'].checked,
    normalizeHeaders: elements['normalize-headers'].checked,
    skipEmptyRows: elements['skip-empty-rows'].checked,
    omitEmptyValues: elements['omit-empty-values'].checked,
    emptyValue: null,
  };
}

async function loadFile(file, requestedSheet = null) {
  setBusy(true);
  state.records = [];
  state.jsonText = '';
  elements['copy-btn'].disabled = true;
  elements['download-btn'].disabled = true;
  setStatus('working', 'Reading locally', 'Validating the file and parsing it inside your browser…');
  setProgress(20, 'Validating file');

  try {
    const result = await parser.parse(file, requestedSheet);
    setProgress(85, 'Preparing workspace');

    state.file = file;
    state.rawRows = result.rows;
    state.sheetNames = result.sheetNames;
    state.selectedSheet = result.selectedSheet;
    state.parseMeta = result;

    elements['file-name'].textContent = file.name;
    elements['file-meta'].textContent = `${bytesToReadable(file.size)} · ${result.sheetJsVersion ? `SheetJS ${result.sheetJsVersion}` : 'SheetJS'} · ${result.workerUsed ? 'Web Worker' : 'Main-thread fallback'}`;
    renderSheetOptions(result.sheetNames, result.selectedSheet);
    renderRawPreview();
    updateMetrics();

    addAudit('success', 'File parsed', `${file.name} · sheet “${result.selectedSheet}” · ${result.rows.length.toLocaleString()} rows parsed locally.`);
    setStatus('success', 'Ready to transform', 'Your data is parsed locally. Choose options, then transform it to JSON.');
    setProgress(100, 'Ready');
    setTimeout(hideProgress, 450);
  } catch (error) {
    handleError(error, 'File could not be parsed');
  } finally {
    setBusy(false);
  }
}

async function transformCurrentData() {
  setBusy(true);
  setStatus('working', 'Transforming safely', 'Applying deterministic transformation rules in small chunks…');
  setProgress(0, 'Starting transformation');

  try {
    const options = readOptions();
    const startedAt = performance.now();

    const transformed = await transformRowsInChunks(state.rawRows, options, ({ percent }) => {
      setProgress(Math.round(percent * 0.7), `Transforming rows · ${percent}%`);
    });

    state.records = transformed.records;

    state.jsonText = await serializeRecords(
      state.records,
      { pretty: elements['pretty-json'].checked, chunkSize: 750 },
      ({ percent }) => setProgress(70 + Math.round(percent * 0.3), `Serializing JSON · ${percent}%`),
    );

    renderJsonPreview();
    elements['copy-btn'].disabled = false;
    elements['download-btn'].disabled = false;

    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    addAudit(
      'success',
      'Transformation complete',
      `${transformed.stats.outputRows.toLocaleString()} records · ${transformed.stats.columns} columns · ${transformed.stats.skippedRows} empty rows skipped · ${elapsed} ms.`,
    );

    setStatus('success', 'JSON is ready', `${transformed.stats.outputRows.toLocaleString()} records transformed. Nothing was uploaded.`);
    setProgress(100, 'Complete');
    setTimeout(hideProgress, 450);
  } catch (error) {
    handleError(error, 'Transformation failed');
  } finally {
    setBusy(false);
  }
}

async function copyJson() {
  if (!state.jsonText) return;
  try {
    await navigator.clipboard.writeText(state.jsonText);
    addAudit('success', 'JSON copied', `${state.records.length.toLocaleString()} records copied to the clipboard.`);
    setStatus('success', 'Copied to clipboard', 'The complete JSON output was copied.');
  } catch {
    addAudit('warning', 'Clipboard unavailable', 'The browser blocked clipboard access; use Download JSON instead.');
    setStatus('warning', 'Clipboard blocked', 'Your browser blocked copying this output. Download the JSON file instead.');
  }
}

function downloadJson() {
  if (!state.jsonText) return;
  const blob = new Blob([state.jsonText], { type: 'application/json;charset=utf-8' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = suggestedDownloadName();
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  revokeDownloadUrl(anchor);

  addAudit('success', 'JSON downloaded', `${anchor.download} generated locally.`);
  setStatus('success', 'Download created', 'Your JSON file was generated locally in this browser.');
}

function resetWorkspace() {
  state.file = null;
  state.rawRows = [];
  state.sheetNames = [];
  state.selectedSheet = null;
  state.records = [];
  state.jsonText = '';
  state.parseMeta = null;
  elements['file-input'].value = '';
  elements['file-name'].textContent = 'No file selected';
  elements['file-meta'].textContent = 'CSV, XLSX or XLS · up to 100 MB';
  elements['sheet-control'].classList.add('hidden');
  elements['sheet-select'].replaceChildren();
  elements['copy-btn'].disabled = true;
  elements['download-btn'].disabled = true;
  elements['transform-btn'].disabled = true;
  elements['header-row'].value = '1';
  renderRawPreview();
  updateMetrics();
  hideProgress();
  addAudit('info', 'Workspace reset', 'In-memory file and transformation state cleared from the interface.');
  setStatus('idle', 'Waiting for a file', 'Select or drop a CSV or Excel file. Processing happens only in your browser.');
}

function handleError(error, fallbackTitle) {
  const known = error instanceof ParserError || error instanceof TransformerError;
  const message = known ? error.message : 'An unexpected browser error occurred. Please retry with a valid file.';
  const code = known ? error.code : 'UNEXPECTED_ERROR';
  console.error('[LocalTransformer]', code, error);
  addAudit('error', fallbackTitle, `${code}: ${message}`);
  setStatus('error', fallbackTitle, message);
  hideProgress();
}

function suppressDrag(event) {
  event.preventDefault();
  event.stopPropagation();
}

function bindDropZone() {
  const zone = elements['drop-zone'];
  ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (event) => {
    suppressDrag(event);
    zone.dataset.dragging = 'true';
  }));

  ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (event) => {
    suppressDrag(event);
    zone.dataset.dragging = 'false';
  }));

  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      elements['file-input'].click();
    }
  });
}

function bindEvents() {
  elements['file-input'].addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
  });

  elements['sheet-select'].addEventListener('change', async (event) => {
    if (!state.file) return;
    await loadFile(state.file, event.target.value);
  });

  elements['header-row'].addEventListener('change', updateMetrics);
  elements['transform-btn'].addEventListener('click', transformCurrentData);
  elements['copy-btn'].addEventListener('click', copyJson);
  elements['download-btn'].addEventListener('click', downloadJson);
  elements['reset-btn'].addEventListener('click', resetWorkspace);
  bindDropZone();
}

function initialize() {
  cacheElements();
  bindEvents();
  renderAudit();
  renderRawPreview();
  updateMetrics();
  setStatus('idle', 'Waiting for a file', 'Select or drop a CSV or Excel file. Processing happens only in your browser.');
}

document.addEventListener('DOMContentLoaded', initialize, { once: true });
