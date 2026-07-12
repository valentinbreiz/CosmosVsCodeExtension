import * as vscode from 'vscode';
import { KernelMemoryProvider, MemoryUpdate, MemoryStats } from './kernelMemoryView';

/**
 * Webview-backed memory map view. Renders the RAT as a colored grid
 * (one cell per page, or per page-bucket on large heaps) so the user
 * sees fragmentation and per-type layout at a glance. Re-renders on
 * every update from <see cref="KernelMemoryProvider.onDidUpdate"/>.
 */
export class KernelMemoryMapViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cosmos.kernelMemoryMap';

    private view: vscode.WebviewView | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly provider: KernelMemoryProvider
    ) {
        provider.onDidUpdate(update => this.postUpdate(update));
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = this.getHtml();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                const latest = this.provider.getLatest();
                if (latest) this.postUpdate(latest);
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
        });

        // Push the most recent snapshot immediately so the user doesn't
        // wait up to a second after opening the view.
        const latest = this.provider.getLatest();
        if (latest) this.postUpdate(latest);
    }

    private postUpdate(update: MemoryUpdate): void {
        if (!this.view) return;
        if (!update.stats) {
            this.view.webview.postMessage({
                type: 'message',
                text: update.message ?? 'Waiting for memory snapshot…',
            });
            return;
        }
        const compact = serializeForWebview(update);
        this.view.webview.postMessage({ type: 'update', payload: compact });
    }

    private getHtml(): string {
        const nonce = makeNonce();
        return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root {
    color-scheme: light dark;
  }
  *, *::before, *::after {
    box-sizing: border-box;
  }
  html, body {
    overflow-x: hidden;
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    margin: 0;
    padding: 6px;
    max-width: 100%;
  }
  #info {
    margin-bottom: 4px;
    font-size: 11px;
    width: 100%;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 6px;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }
  .row:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-list-hoverForeground);
  }
  .row .label {
    color: var(--vscode-foreground);
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .row .value {
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-left: auto;
    text-align: right;
    min-width: 0;
  }
  #stats {
    font-size: 11px;
    line-height: 1.35;
    margin: 6px 6px 4px;
    color: var(--vscode-descriptionForeground);
  }
  #stats b {
    color: var(--vscode-foreground);
  }
  #grid-wrap {
    position: relative;
    width: 100%;
    max-width: 100%;
  }
  canvas {
    display: block;
    width: 100%;
    max-width: 100%;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    cursor: crosshair;
    border: 1px solid var(--vscode-panel-border);
  }
  #tooltip {
    position: absolute;
    pointer-events: none;
    background: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    padding: 4px 6px;
    font-size: 11px;
    line-height: 1.4;
    white-space: nowrap;
    display: none;
    z-index: 10;
    border-radius: 2px;
  }
  #legend {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin-top: 6px;
    font-size: 11px;
    width: 100%;
    min-width: 0;
  }
  .legend-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
    height: 20px;
    padding: 0 6px;
  }
  .legend-row:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .legend-row .name {
    color: var(--vscode-foreground);
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .legend-row .count {
    color: var(--vscode-descriptionForeground);
    margin-left: auto;
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border: 1px solid var(--vscode-panel-border);
    flex: none;
  }
  #empty-msg {
    color: var(--vscode-descriptionForeground);
    padding: 12px 4px;
    font-style: italic;
  }
  details {
    margin-top: 4px;
  }
  details > summary {
    cursor: pointer;
    color: var(--vscode-foreground);
    font-size: 11px;
    user-select: none;
    padding: 4px 6px;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  details > summary::-webkit-details-marker {
    display: none;
  }
  details > summary::before {
    content: '▸';
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    width: 10px;
    display: inline-block;
    transition: transform 0.1s ease;
  }
  details[open] > summary::before {
    transform: rotate(90deg);
  }
  details > summary:hover {
    background: var(--vscode-list-hoverBackground);
  }
  hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border);
    margin: 6px 0;
  }
</style>
</head>
<body>
  <div id="empty-msg" style="display:none">Start a Cosmos debug session to inspect memory manager state.</div>
  <div id="info">
    <div id="stats">Waiting for snapshot…</div>
    <div id="grid-wrap">
      <canvas id="grid" width="1" height="1"></canvas>
      <div id="tooltip"></div>
    </div>
    <div id="legend"></div>
  </div>

<script nonce="${nonce}">
(() => {
  const vscodeApi = acquireVsCodeApi();
  const canvas = document.getElementById('grid');
  const tooltip = document.getElementById('tooltip');
  const ctx = canvas.getContext('2d');
  const statsEl = document.getElementById('stats');
  const legendEl = document.getElementById('legend');
  const emptyEl = document.getElementById('empty-msg');
  const infoEl = document.getElementById('info');
  const gridWrap = document.getElementById('grid-wrap');

  // PageType bytes — keep in sync with kernel PageType.cs.
  const PT = {
    EMPTY: 0, GCHEAP: 1, HEAPSMALL: 3, HEAPMEDIUM: 5, HEAPLARGE: 7,
    UNMANAGED: 9, PAGEDIRECTORY: 11, PAGEALLOCATOR: 32, SMT: 64, EXTENSION: 128,
  };
  const TYPE_INFO = [
    { id: PT.EMPTY,         name: 'Empty',         color: '#1e2229' },
    { id: PT.GCHEAP,        name: 'GCHeap',        color: '#4ec9b0' },
    { id: PT.HEAPSMALL,     name: 'HeapSmall',     color: '#569cd6' },
    { id: PT.HEAPMEDIUM,    name: 'HeapMedium',    color: '#e6a32e' },
    { id: PT.HEAPLARGE,     name: 'HeapLarge',     color: '#a374d5' },
    { id: PT.UNMANAGED,     name: 'Unmanaged',     color: '#ce9178' },
    { id: PT.PAGEDIRECTORY, name: 'PageDirectory', color: '#dcdcaa' },
    { id: PT.PAGEALLOCATOR, name: 'PageAllocator', color: '#b5cea8' },
    { id: PT.SMT,           name: 'SMT',           color: '#f48771' },
    { id: PT.EXTENSION,     name: 'Extension',     color: '#6e6e6e' },
  ];
  const colorByType = new Map(TYPE_INFO.map(t => [t.id, t.color]));
  const UNKNOWN_COLOR = '#ff0066';

  let lastPayload = null;
  /** Flat Uint8Array indexed [cellRow*cols + cellCol] = dominantType. */
  let dominantGrid = null;
  /** Per-cell counts per type for tooltips: Map<typeByte, number>[] indexed by cell. */
  let cellTypeCounts = null;
  let cellRows = 0, cellCols = 0, cellSize = 0;
  let pagesPerCell = 1;

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    const kb = n / 1024;
    if (kb < 1024) return kb.toFixed(1) + ' KiB';
    const mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(2) + ' MiB';
    return (mb / 1024).toFixed(2) + ' GiB';
  }

  function chooseLayout(totalPages) {
    // Aim for a grid that fits the visible width with reasonable cell
    // size. We pick pagesPerCell as the smallest power-of-two that keeps
    // total cells under ~maxCells, then size cells to fill the width.
    const containerW = canvas.parentElement.clientWidth - 2; // border
    const maxCellsTarget = 16000; // ~128 cols × 128 rows worth — fast to draw.
    let ppc = 1;
    while (Math.ceil(totalPages / ppc) > maxCellsTarget) {
      ppc *= 2;
    }
    const cells = Math.ceil(totalPages / ppc);
    // Pick column count = floor(containerW / minCell) constrained so rows aren't absurd.
    const minCellPx = 6;
    let cols = Math.max(8, Math.floor(containerW / minCellPx));
    if (cols > cells) cols = cells;
    const rows = Math.ceil(cells / cols);
    const cellPx = Math.max(2, Math.floor(containerW / cols));
    return { ppc, cols, rows, cellPx };
  }

  function buildGrid(payload) {
    const total = payload.totalPages;
    if (!total || !payload.extents) {
      dominantGrid = null;
      cellTypeCounts = null;
      return;
    }
    const layout = chooseLayout(total);
    pagesPerCell = layout.ppc;
    cellCols = layout.cols;
    cellRows = layout.rows;
    cellSize = layout.cellPx;
    const totalCells = cellCols * cellRows;
    cellTypeCounts = new Array(totalCells);
    dominantGrid = new Uint8Array(totalCells);

    // Walk extents and accumulate per-cell type counts.
    for (let i = 0; i < totalCells; i++) cellTypeCounts[i] = null;
    const ext = payload.extents;
    for (let e = 0; e < ext.length; e += 3) {
      const start = ext[e], len = ext[e + 1], type = ext[e + 2];
      const end = start + len;
      let p = start;
      while (p < end) {
        const cell = Math.floor(p / pagesPerCell);
        const cellEnd = Math.min(end, (cell + 1) * pagesPerCell);
        const span = cellEnd - p;
        let counts = cellTypeCounts[cell];
        if (counts === null) {
          counts = new Map();
          cellTypeCounts[cell] = counts;
        }
        counts.set(type, (counts.get(type) || 0) + span);
        p = cellEnd;
      }
    }
    // Pick dominant type per cell.
    for (let c = 0; c < totalCells; c++) {
      const counts = cellTypeCounts[c];
      if (!counts) continue;
      let best = -1, bestCount = -1;
      counts.forEach((v, k) => {
        if (v > bestCount) { bestCount = v; best = k; }
      });
      dominantGrid[c] = best & 0xff;
    }
  }

  function paint() {
    if (!dominantGrid) {
      if (canvas.width !== 1 || canvas.height !== 1) {
        canvas.width = 1; canvas.height = 1;
      }
      return;
    }
    const w = cellCols * cellSize;
    const h = cellRows * cellSize;
    // Only assign canvas.width/height when they actually change — assigning
    // these clears the bitmap and triggers a reflow, which the user sees as
    // a flicker if done every poll. Filling pixels on a same-size canvas is
    // invisible (no flash).
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.height = h + 'px';
    }
    for (let r = 0; r < cellRows; r++) {
      for (let c = 0; c < cellCols; c++) {
        const idx = r * cellCols + c;
        const counts = cellTypeCounts[idx];
        let color;
        if (!counts) {
          color = '#1a1d20';
        } else {
          const t = dominantGrid[idx];
          color = colorByType.get(t) || UNKNOWN_COLOR;
        }
        ctx.fillStyle = color;
        ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
      }
    }
  }

  function renderLegend(payload) {
    if (!payload || !payload.typeCounts) {
      legendEl.replaceChildren();
      return;
    }
    const tc = payload.typeCounts;
    const total = payload.totalPages || 1;
    // Sort by count desc, then by declaration order. Drop zero-count
    // entries so the legend only shows what's actually on the heap.
    const entries = TYPE_INFO
      .map((info, idx) => ({ info, count: tc[info.id] || 0, idx }))
      .filter(e => e.count > 0)
      .sort((a, b) => b.count - a.count || a.idx - b.idx);
    const frag = document.createDocumentFragment();
    if (entries.length === 0) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.style.color = 'var(--vscode-descriptionForeground)';
      row.textContent = '(no pages yet)';
      frag.appendChild(row);
    } else {
      for (const e of entries) {
        const pct = (e.count * 100 / total);
        const pctText = pct >= 10 ? pct.toFixed(0) + '%' : pct.toFixed(1) + '%';
        const row = document.createElement('div');
        row.className = 'legend-row';
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = e.info.color;
        const lbl = document.createElement('span');
        lbl.className = 'name';
        lbl.textContent = e.info.name;
        const cnt = document.createElement('span');
        cnt.className = 'count';
        cnt.textContent = e.count.toLocaleString() + '  ' + pctText;
        row.title = e.info.name + ': ' + e.count + ' pages (' + pct.toFixed(2) + '%)';
        row.appendChild(sw);
        row.appendChild(lbl);
        row.appendChild(cnt);
        frag.appendChild(row);
      }
    }
    // Atomic swap — never an empty frame.
    legendEl.replaceChildren(frag);
  }

  function renderStats(payload) {
    if (!payload) {
      statsEl.textContent = 'No snapshot.';
      return;
    }
    const ps = payload.pageSize;
    const total = payload.totalPages;
    const free = payload.freePages;
    const used = total - free;
    statsEl.innerHTML =
      '<b>' + total + '</b> pages × ' + ps + ' B = ' + formatBytes(total * ps) +
      ' &nbsp;|&nbsp; used <b>' + used + '</b> (' + formatBytes(used * ps) + ')' +
      ' &nbsp;|&nbsp; free <b>' + free + '</b> (' + formatBytes(free * ps) + ')' +
      '<br/>cell = <b>' + pagesPerCell + '</b> page' + (pagesPerCell === 1 ? '' : 's') +
      ', grid ' + cellCols + ' × ' + cellRows;
  }


  canvas.addEventListener('mousemove', evt => {
    if (!dominantGrid || !cellSize) { tooltip.style.display = 'none'; return; }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (evt.clientX - rect.left) * scaleX;
    const py = (evt.clientY - rect.top) * scaleY;
    const c = Math.floor(px / cellSize);
    const r = Math.floor(py / cellSize);
    if (c < 0 || c >= cellCols || r < 0 || r >= cellRows) {
      tooltip.style.display = 'none';
      return;
    }
    const idx = r * cellCols + c;
    const pageStart = idx * pagesPerCell;
    const pageEnd = Math.min(pageStart + pagesPerCell, lastPayload.totalPages);
    const counts = cellTypeCounts[idx];
    const lines = [
      'Pages [' + pageStart + '..' + pageEnd + ')',
    ];
    if (counts) {
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [type, cnt] of entries) {
        const info = TYPE_INFO.find(t => t.id === type);
        const name = info ? info.name : ('Type=' + type);
        lines.push(name + ': ' + cnt);
      }
    } else {
      lines.push('(no data)');
    }
    tooltip.innerHTML = lines.join('<br/>');
    tooltip.style.display = 'block';
    // Place the box at the cursor's lower-right by default; flip to
    // upper-left when it would spill past the grid-wrap edges so the
    // box stays fully visible even when hovering the bottom-right cell.
    const offset = 12;
    const cursorX = evt.clientX - rect.left;
    const cursorY = evt.clientY - rect.top;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const containerW = gridWrap.clientWidth;
    const containerH = gridWrap.clientHeight;
    let left = cursorX + offset;
    if (left + tw > containerW) {
      left = cursorX - tw - offset;
      if (left < 0) left = 0;
    }
    let top = cursorY + offset;
    if (top + th > containerH) {
      top = cursorY - th - offset;
      if (top < 0) top = 0;
    }
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  let resizePending = false;
  window.addEventListener('resize', () => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      if (lastPayload) {
        buildGrid(lastPayload);
        paint();
        renderStats(lastPayload);
      }
    });
  });

  function setDisplay(el, v) {
    if (el.style.display !== v) {
      el.style.display = v;
    }
  }

  function showMessage(text) {
    setDisplay(emptyEl, 'block');
    if (emptyEl.textContent !== text) emptyEl.textContent = text;
    setDisplay(infoEl, 'none');
    legendEl.replaceChildren();
    if (canvas.width !== 1 || canvas.height !== 1) {
      canvas.width = 1; canvas.height = 1;
    }
    lastPayload = null;
  }

  function showSnapshot() {
    setDisplay(emptyEl, 'none');
    setDisplay(infoEl, 'block');
  }

  // Coalesce updates onto rAF so we paint at most once per frame even if
  // the host posts faster. Avoids the "view flashing" caused by repeated
  // synchronous reflows on each 1 Hz poll.
  let pendingMsg = null;
  let rafScheduled = false;
  function flush() {
    rafScheduled = false;
    const msg = pendingMsg;
    pendingMsg = null;
    if (!msg) return;
    if (msg.type === 'message') {
      showMessage(msg.text || 'No data.');
      return;
    }
    if (msg.type === 'update') {
      lastPayload = msg.payload;
      if (!lastPayload || !lastPayload.totalPages) {
        showMessage('Memory snapshot not initialized yet.');
        return;
      }
      showSnapshot();
      buildGrid(lastPayload);
      paint();
      renderStats(lastPayload);
      renderLegend(lastPayload);
    }
  }
  window.addEventListener('message', evt => {
    const msg = evt.data;
    if (!msg) return;
    pendingMsg = msg;
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(flush);
    }
  });

  vscodeApi.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}

function makeNonce(): string {
    let out = '';
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}

/**
 * Serializes the latest update into a compact JSON payload for the webview.
 * Extents are flattened to a Number[] (start, length, type triples) since
 * BigInt isn't structured-clone-friendly across postMessage.
 */
function serializeForWebview(update: MemoryUpdate): any {
    if (!update.stats) {
        return null;
    }
    const s: MemoryStats = update.stats;
    const flatExtents: number[] = [];
    if (update.extents) {
        for (const e of update.extents) {
            flatExtents.push(e.start, e.length, e.type);
        }
    }
    const typeCounts: Record<number, number> = {
        0: Number(s.pagesEmpty),
        1: Number(s.pagesGCHeap),
        3: Number(s.pagesHeapSmall),
        5: Number(s.pagesHeapMedium),
        7: Number(s.pagesHeapLarge),
        9: Number(s.pagesUnmanaged),
        11: Number(s.pagesPageDirectory),
        32: Number(s.pagesPageAllocator),
        64: Number(s.pagesSMT),
        128: Number(s.pagesExtension),
    };
    return {
        initialized: s.initialized,
        pageSize: s.pageSize,
        totalPages: Number(s.totalPageCount),
        freePages: Number(s.freePageCount),
        ramStart: '0x' + s.ramStart.toString(16),
        ratAddress: '0x' + s.ratAddress.toString(16),
        extents: flatExtents,
        typeCounts,
        error: update.extentsError,
    };
}

