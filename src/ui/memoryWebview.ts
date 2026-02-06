import * as vscode from 'vscode';
import { getSharedMemoryPath } from '../commands/debug';
import * as fs from 'fs';

// Constants from kernel
const MAGIC_NUMBER = 0x434F534D4F53n; // "COSMOS"
const MAX_LIMINE_ENTRIES = 64;
const MAX_RAT_SAMPLE = 1000;

// Page types from Cosmos PageType enum
export enum PageType {
    Empty = 0,
    HeapSmall = 3,
    HeapMedium = 5,
    HeapLarge = 7,
    Unmanaged = 9,
    PageDirectory = 11,
    PageAllocator = 32,  // RAT pages
    SMT = 64,            // Size Map Table
    Extension = 128
}

// Limine memory map entry types
export enum LimineMemmapType {
    Usable = 0,
    Reserved = 1,
    AcpiReclaimable = 2,
    AcpiNvs = 3,
    BadMemory = 4,
    BootloaderReclaimable = 5,
    KernelAndModules = 6,
    Framebuffer = 7
}

// Limine memory map entry
export interface LimineMemoryEntry {
    base: string;
    length: number;
    type: LimineMemmapType;
    typeName: string;
}

// Page in the RAT
export interface MemoryPage {
    index: number;
    address: string;
    size: number;
    pageType: PageType;
    pageTypeName: string;
}

// Page Allocator state
export interface PageAllocatorState {
    ramStart: string;
    heapEnd: string;
    ratLocation: string;
    ramSize: number;
    totalPageCount: number;
    freePageCount: number;
    usedPageCount: number;
    pages: MemoryPage[];
}

// Full memory state
export interface MemoryState {
    limineMemoryMap: LimineMemoryEntry[];
    pageAllocator: PageAllocatorState;
    lastUpdated: number;
}

let currentMemoryState: MemoryState | null = null;
let memoryPanel: vscode.WebviewPanel | undefined;
let shmemPath: string | null = null;
let pollTimer: NodeJS.Timeout | undefined;
let isLive: boolean = false;

// Polling interval in milliseconds (1 second)
const POLL_INTERVAL_MS = 1000;

/**
 * Start automatic polling for memory updates.
 */
function startPolling(): void {
    console.log('[MemoryDebug] Starting polling...');

    // Clear any existing timer
    if (pollTimer) {
        clearInterval(pollTimer);
    }

    isLive = true;
    updateLiveIndicator();

    // Poll immediately
    console.log('[MemoryDebug] First poll...');
    requestMemoryData();

    // Then poll at regular intervals
    pollTimer = setInterval(() => {
        console.log('[MemoryDebug] Polling for updates...');
        requestMemoryData();
    }, POLL_INTERVAL_MS);

    console.log('[MemoryDebug] Polling started, interval:', POLL_INTERVAL_MS, 'ms');
}

/**
 * Stop automatic polling.
 */
function stopPolling(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
    }
    isLive = false;
    updateLiveIndicator();
}

/**
 * Update the live indicator in the webview.
 */
function updateLiveIndicator(): void {
    if (!memoryPanel) {
        return;
    }

    memoryPanel.webview.postMessage({
        command: 'updateLiveStatus',
        isLive: isLive
    });
}

/**
 * Request memory debug data from kernel via ivshmem (live, zero-pause streaming).
 */
export async function requestMemoryData(): Promise<void> {
    try {
        // Get shared memory path (first time only)
        if (shmemPath === null) {
            shmemPath = getSharedMemoryPath() || null;
            if (!shmemPath) {
                console.log('[MemoryDebug] Shared memory path not yet available, waiting...');
                return; // Will retry on next poll
            }
            console.log('[MemoryDebug] Using shared memory file:', shmemPath);
        }

        // Check if file exists
        if (!fs.existsSync(shmemPath)) {
            console.log('[MemoryDebug] Shared memory file not yet created, waiting...');
            return; // Will retry on next poll
        }

        // Read and parse buffer from shared memory file (zero-pause!)
        await readAndParseBufferFromFile(shmemPath);

        if (memoryPanel) {
            memoryPanel.reveal(vscode.ViewColumn.Beside, true);
        }

    } catch (error) {
        console.error('[MemoryDebug] Failed to read memory:', error);
        // Don't show error popup on every poll failure, just log it
        // The loading screen will remain until we get valid data
    }
}

/**
 * Read and parse the debug buffer from shared memory file (zero-pause streaming).
 */
async function readAndParseBufferFromFile(filePath: string): Promise<void> {
    // Calculate total buffer size
    const bufferSize = 8 + 4 + 8 + 4 + (MAX_LIMINE_ENTRIES * 3 * 8) + 8 + 8 + 8 + 8 + 8 + 8 + 4 + MAX_RAT_SAMPLE;

    // Read entire buffer from shared memory file (zero-pause!)
    const buffer = fs.readFileSync(filePath);

    // Parse the buffer
    let offset = 0;

    // Read header
    const magic = buffer.readBigUInt64LE(offset); offset += 8;
    const version = buffer.readUInt32LE(offset); offset += 4;
    const timestamp = buffer.readBigUInt64LE(offset); offset += 8;

    console.log('[MemoryDebug] Read from ivshmem - Magic:', '0x' + magic.toString(16), 'Expected:', '0x' + MAGIC_NUMBER.toString(16), 'Version:', version, 'Timestamp:', timestamp);

    if (magic !== MAGIC_NUMBER) {
        throw new Error(`Invalid magic number: got 0x${magic.toString(16)}, expected 0x${MAGIC_NUMBER.toString(16)}. Kernel may not have initialized the buffer yet.`);
    }

    // Read Limine memory map
    const limineEntryCount = buffer.readUInt32LE(offset); offset += 4;
    const limineMemoryMap: LimineMemoryEntry[] = [];

    for (let i = 0; i < limineEntryCount && i < MAX_LIMINE_ENTRIES; i++) {
        const base = buffer.readBigUInt64LE(offset); offset += 8;
        const length = buffer.readBigUInt64LE(offset); offset += 8;
        const type = buffer.readBigUInt64LE(offset); offset += 8;

        limineMemoryMap.push({
            base: '0x' + base.toString(16).toUpperCase(),
            length: Number(length),
            type: Number(type) as LimineMemmapType,
            typeName: getLimineTypeName(Number(type) as LimineMemmapType)
        });
    }

    // Skip unused Limine entries
    offset = 8 + 4 + 8 + 4 + (MAX_LIMINE_ENTRIES * 3 * 8);

    // Read page allocator state
    const ramStart = buffer.readBigUInt64LE(offset); offset += 8;
    const heapEnd = buffer.readBigUInt64LE(offset); offset += 8;
    const ratLocation = buffer.readBigUInt64LE(offset); offset += 8;
    const ramSize = buffer.readBigUInt64LE(offset); offset += 8;
    const totalPageCount = buffer.readBigUInt64LE(offset); offset += 8;
    const freePageCount = buffer.readBigUInt64LE(offset); offset += 8;

    // Read RAT sample
    const ratSampleCount = buffer.readUInt32LE(offset); offset += 4;
    const pages: MemoryPage[] = [];

    for (let i = 0; i < ratSampleCount && i < MAX_RAT_SAMPLE; i++) {
        const pageType = buffer.readUInt8(offset + i) as PageType;
        const address = ramStart + BigInt(i * 4096);
        pages.push({
            index: i,
            address: '0x' + address.toString(16).toUpperCase(),
            size: 4096,
            pageType,
            pageTypeName: getPageTypeName(pageType)
        });
    }

    // Update state
    currentMemoryState = {
        limineMemoryMap,
        pageAllocator: {
            ramStart: '0x' + ramStart.toString(16).toUpperCase(),
            heapEnd: '0x' + heapEnd.toString(16).toUpperCase(),
            ratLocation: '0x' + ratLocation.toString(16).toUpperCase(),
            ramSize: Number(ramSize),
            totalPageCount: Number(totalPageCount),
            freePageCount: Number(freePageCount),
            usedPageCount: Number(totalPageCount - freePageCount),
            pages
        },
        lastUpdated: Date.now()
    };

    updateWebview();
}

/**
 * Read and parse the debug buffer by reading individual fields (GDB - deprecated).
 */
async function readAndParseBuffer(session: vscode.DebugSession, baseAddr: string): Promise<void> {
    const base = BigInt(baseAddr);

    // Helper to read a value at offset
    const readU64 = async (offset: number): Promise<bigint> => {
        const addr = '0x' + (base + BigInt(offset)).toString(16);
        const result = await session.customRequest('evaluate', {
            expression: `*(unsigned long long*)${addr}`,
            context: 'watch'
        });
        return BigInt(result.result);
    };

    const readU32 = async (offset: number): Promise<number> => {
        const addr = '0x' + (base + BigInt(offset)).toString(16);
        const result = await session.customRequest('evaluate', {
            expression: `*(unsigned int*)${addr}`,
            context: 'watch'
        });
        return parseInt(result.result);
    };

    const readU8 = async (offset: number): Promise<number> => {
        const addr = '0x' + (base + BigInt(offset)).toString(16);
        const result = await session.customRequest('evaluate', {
            expression: `*(unsigned char*)${addr}`,
            context: 'watch'
        });
        return parseInt(result.result);
    };

    let offset = 0;

    // Read header
    const magic = await readU64(offset); offset += 8;
    const version = await readU32(offset); offset += 4;
    const timestamp = await readU64(offset); offset += 8;

    console.log('[MemoryDebug] Magic:', magic.toString(16), 'Version:', version, 'Timestamp:', timestamp);

    if (magic !== MAGIC_NUMBER) {
        throw new Error('Invalid magic number in debug buffer');
    }

    // Read Limine memory map
    const limineEntryCount = await readU32(offset); offset += 4;
    const limineMemoryMap: LimineMemoryEntry[] = [];

    for (let i = 0; i < limineEntryCount && i < MAX_LIMINE_ENTRIES; i++) {
        const base = await readU64(offset); offset += 8;
        const length = await readU64(offset); offset += 8;
        const type = await readU64(offset); offset += 8;

        limineMemoryMap.push({
            base: '0x' + base.toString(16).toUpperCase(),
            length: Number(length),
            type: Number(type) as LimineMemmapType,
            typeName: getLimineTypeName(Number(type) as LimineMemmapType)
        });
    }

    // Skip unused Limine entries
    offset = 8 + 4 + 8 + 4 + (MAX_LIMINE_ENTRIES * 3 * 8);

    // Read page allocator state
    const ramStart = await readU64(offset); offset += 8;
    const heapEnd = await readU64(offset); offset += 8;
    const ratLocation = await readU64(offset); offset += 8;
    const ramSize = await readU64(offset); offset += 8;
    const totalPageCount = await readU64(offset); offset += 8;
    const freePageCount = await readU64(offset); offset += 8;

    // Read RAT sample
    const ratSampleCount = await readU32(offset); offset += 4;
    const pages: MemoryPage[] = [];

    for (let i = 0; i < ratSampleCount && i < MAX_RAT_SAMPLE; i++) {
        const pageType = await readU8(offset + i) as PageType;
        const address = ramStart + BigInt(i * 4096);
        pages.push({
            index: i,
            address: '0x' + address.toString(16).toUpperCase(),
            size: 4096,
            pageType,
            pageTypeName: getPageTypeName(pageType)
        });
    }

    // Update state
    currentMemoryState = {
        limineMemoryMap,
        pageAllocator: {
            ramStart: '0x' + ramStart.toString(16).toUpperCase(),
            heapEnd: '0x' + heapEnd.toString(16).toUpperCase(),
            ratLocation: '0x' + ratLocation.toString(16).toUpperCase(),
            ramSize: Number(ramSize),
            totalPageCount: Number(totalPageCount),
            freePageCount: Number(freePageCount),
            usedPageCount: Number(totalPageCount - freePageCount),
            pages
        },
        lastUpdated: Date.now()
    };

    updateWebview();
}

/**
 * Update the webview with current memory state.
 * First time: Replace HTML with full viewer.
 * Subsequent times: Send data via postMessage for smooth updates.
 */
function updateWebview(): void {
    if (!memoryPanel || !currentMemoryState) {
        return;
    }

    // Check if we need to do initial HTML load
    // We detect this by checking if the panel was created with loading HTML
    const needsInitialLoad = !memoryPanel.webview.html.includes('pages-grid');

    if (needsInitialLoad) {
        console.log('[MemoryDebug] First data received, loading full viewer HTML...');
        memoryPanel.webview.html = getMemoryWebviewContent(currentMemoryState);
    } else {
        // Send updated data to webview for smooth updates
        console.log('[MemoryDebug] Sending data update to webview, timestamp:', currentMemoryState.lastUpdated);
        memoryPanel.webview.postMessage({
            command: 'updateData',
            data: currentMemoryState
        });
    }
}

/**
 * Get current memory state if available.
 */
export function getMemoryState(): MemoryState | null {
    return currentMemoryState;
}

export function showMemoryRegions(context: vscode.ExtensionContext) {
    // Check if debugging has started
    const path = getSharedMemoryPath();
    if (!path) {
        vscode.window.showWarningMessage(
            'Memory viewer requires an active debug session. Start debugging first (F5 or Debug button).',
            'Start Debugging'
        ).then(selection => {
            if (selection === 'Start Debugging') {
                vscode.commands.executeCommand('workbench.action.debug.start');
            }
        });
        return;
    }

    // If panel already exists, reveal it
    if (memoryPanel) {
        memoryPanel.reveal(vscode.ViewColumn.Beside);
        // Start polling if not already started
        if (!pollTimer) {
            startPolling();
        }
        return;
    }

    // Create panel
    memoryPanel = vscode.window.createWebviewPanel(
        'cosmosMemory',
        'Memory Regions',
        {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: false
        },
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    // Show loading state or real data if already available
    if (currentMemoryState) {
        memoryPanel.webview.html = getMemoryWebviewContent(currentMemoryState);
    } else {
        memoryPanel.webview.html = getLoadingWebviewContent();
    }

    // Start automatic polling for live updates
    startPolling();

    // Handle messages from webview (none currently, but kept for future use)
    memoryPanel.webview.onDidReceiveMessage(
        message => {
            // No commands currently handled
        },
        undefined,
        context.subscriptions
    );

    // Clean up when panel is closed
    memoryPanel.onDidDispose(() => {
        stopPolling();
        memoryPanel = undefined;
    });
}

export function closeMemoryPanel() {
    // Stop polling
    stopPolling();

    if (memoryPanel) {
        memoryPanel.dispose();
        memoryPanel = undefined;
    }
    // Clear state for next session
    currentMemoryState = null;
    shmemPath = null;
}

/**
 * Handle debug session termination - stop polling but keep panel open.
 */
export function onDebugSessionEnded() {
    stopPolling();
    // Clear shared memory path for next session
    shmemPath = null;
}

/**
 * Handle debug session start - resume polling if panel is open.
 */
export function onDebugSessionStarted() {
    // If panel is open and not currently polling, restart
    if (memoryPanel && !isLive) {
        startPolling();
    }
}

export function refreshMemoryPanel() {
    if (memoryPanel && currentMemoryState) {
        memoryPanel.webview.html = getMemoryWebviewContent(currentMemoryState);
    }
}

/**
 * Get loading state HTML while waiting for kernel data.
 */
function getLoadingWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Memory Regions</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 0; margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        .loading-container {
            text-align: center;
        }
        .spinner {
            width: 48px;
            height: 48px;
            border: 4px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
            border-top-color: var(--vscode-focusBorder, #007acc);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 24px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .loading-text {
            font-size: 16px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        .loading-hint {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.7;
        }
    </style>
</head>
<body>
    <div class="loading-container">
        <div class="spinner"></div>
        <div class="loading-text">Reading memory debug buffer...</div>
        <div class="loading-hint">Streaming kernel memory via ivshmem (zero-pause)</div>
    </div>
</body>
</html>`;
}

function getPageTypeName(type: PageType): string {
    switch (type) {
        case PageType.Empty: return 'Empty';
        case PageType.HeapSmall: return 'HeapSmall';
        case PageType.HeapMedium: return 'HeapMedium';
        case PageType.HeapLarge: return 'HeapLarge';
        case PageType.Unmanaged: return 'Unmanaged';
        case PageType.PageDirectory: return 'PageDirectory';
        case PageType.PageAllocator: return 'RAT';
        case PageType.SMT: return 'SMT';
        case PageType.Extension: return 'Extension';
        default: return 'Unknown';
    }
}

function getLimineTypeName(type: LimineMemmapType): string {
    switch (type) {
        case LimineMemmapType.Usable: return 'Usable';
        case LimineMemmapType.Reserved: return 'Reserved';
        case LimineMemmapType.AcpiReclaimable: return 'ACPI Reclaimable';
        case LimineMemmapType.AcpiNvs: return 'ACPI NVS';
        case LimineMemmapType.BadMemory: return 'Bad Memory';
        case LimineMemmapType.BootloaderReclaimable: return 'Bootloader Reclaimable';
        case LimineMemmapType.KernelAndModules: return 'Kernel and Modules';
        case LimineMemmapType.Framebuffer: return 'Framebuffer';
        default: return 'Unknown';
    }
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    } else if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} B`;
}

// Colors for page types
function getPageTypeColor(type: PageType): string {
    switch (type) {
        case PageType.Empty: return '#2ecc71';      // Green - free
        case PageType.HeapSmall: return '#3498db';  // Blue
        case PageType.HeapMedium: return '#9b59b6'; // Purple
        case PageType.HeapLarge: return '#e74c3c';  // Red
        case PageType.Unmanaged: return '#f39c12';  // Orange
        case PageType.PageDirectory: return '#1abc9c'; // Teal
        case PageType.PageAllocator: return '#7f8c8d'; // Gray (RAT)
        case PageType.SMT: return '#e67e22';        // Dark orange
        case PageType.Extension: return '#95a5a6';  // Light gray
        default: return '#bdc3c7';
    }
}

function getLimineTypeColor(type: LimineMemmapType): string {
    switch (type) {
        case LimineMemmapType.Usable: return '#2ecc71';
        case LimineMemmapType.Reserved: return '#7f8c8d';
        case LimineMemmapType.AcpiReclaimable: return '#1abc9c';
        case LimineMemmapType.AcpiNvs: return '#16a085';
        case LimineMemmapType.BadMemory: return '#c0392b';
        case LimineMemmapType.KernelAndModules: return '#e74c3c';
        case LimineMemmapType.Framebuffer: return '#9b59b6';
        case LimineMemmapType.BootloaderReclaimable: return '#f39c12';
        default: return '#bdc3c7';
    }
}

// (Continuing with the rest of the HTML generation - keeping existing visualization code...)
function getMemoryWebviewContent(state: MemoryState): string {
    const pa = state.pageAllocator;
    const usedPercent = ((pa.usedPageCount / pa.totalPageCount) * 100).toFixed(1);

    // Count pages by type
    const pageCounts: Record<number, number> = {};
    pa.pages.forEach(p => {
        pageCounts[p.pageType] = (pageCounts[p.pageType] || 0) + 1;
    });

    // Generate page grid
    const pageGrid = pa.pages.map(page => {
        const color = getPageTypeColor(page.pageType);
        return `<div class="page-cell"
            style="background-color: ${color};"
            data-page-index="${page.index}"
            data-address="${page.address}"
            data-type="${page.pageType}"
            data-type-name="${page.pageTypeName}"
            data-size="${page.size}"
        ></div>`;
    }).join('');

    // Generate Limine memory map rows
    const limineRows = state.limineMemoryMap.map((entry, i) => {
        const color = getLimineTypeColor(entry.type);
        return `
            <tr>
                <td><span class="color-dot" style="background-color: ${color};"></span></td>
                <td class="mono">${entry.base}</td>
                <td>${formatBytes(entry.length)}</td>
                <td><span class="type-badge" style="background-color: ${color}20; color: ${color};">${entry.typeName}</span></td>
            </tr>
        `;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Memory Regions</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 0; margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.5;
        }
        .container { padding: 32px 24px; }
        .header { margin-bottom: 32px; }
        .header-top { display: flex; justify-content: space-between; align-items: flex-start; }
        .header h1 { font-size: 28px; font-weight: 600; margin: 0 0 4px 0; }
        .header .subtitle { color: var(--vscode-descriptionForeground); font-size: 14px; }
        .header-actions { display: flex; align-items: center; gap: 12px; }

        .overview-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
        .overview-card {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            border-radius: 8px; padding: 16px;
        }
        .overview-card-value { font-size: 24px; font-weight: 600; margin-bottom: 4px; }
        .overview-card-label { font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }

        .section {
            margin-bottom: 24px; background: var(--vscode-input-background);
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            border-radius: 8px; overflow: hidden;
        }
        .section-title {
            font-size: 14px; font-weight: 500; padding: 16px 20px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            cursor: pointer; display: flex; align-items: center; justify-content: space-between;
            user-select: none; transition: background-color 0.15s;
        }
        .section-title:hover { background: var(--vscode-list-hoverBackground); }
        .section-title .chevron { transition: transform 0.2s; font-size: 10px; color: var(--vscode-descriptionForeground); }
        .section.collapsed .section-title .chevron { transform: rotate(-90deg); }
        .section-content { padding: 20px; }
        .section.collapsed .section-content { display: none; }

        .info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 16px; }
        .info-item { display: flex; flex-direction: column; gap: 4px; }
        .info-label { font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
        .info-value { font-size: 14px; font-weight: 500; }
        .mono { font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 13px; }

        .usage-bar { height: 6px; background: var(--vscode-editor-background); border-radius: 3px; overflow: hidden; margin-bottom: 16px; }
        .usage-bar-fill { height: 100%; border-radius: 3px; background: #3498db; }

        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1)); }
        th { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); font-weight: 500; }
        .color-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
        .type-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; }

        .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
        .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
        .legend-dot { width: 12px; height: 12px; border-radius: 3px; }

        .pages-grid { display: grid; grid-template-columns: repeat(auto-fill, 14px); gap: 2px; margin: 16px 0; }
        .page-cell { width: 14px; height: 14px; border-radius: 2px; cursor: pointer; transition: transform 0.1s; }
        .page-cell:hover { transform: scale(1.5); box-shadow: 0 2px 8px rgba(0,0,0,0.4); z-index: 10; position: relative; }

        .page-details { background: var(--vscode-editor-background); border-radius: 6px; padding: 16px; min-height: 60px; }
        .page-details-placeholder { color: var(--vscode-descriptionForeground); font-size: 13px; font-style: italic; }
        .page-details-content { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }

        .btn {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 10px 16px; font-size: 13px; font-weight: 500;
            border: none; border-radius: 6px; cursor: pointer;
        }
        .btn-secondary { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }

        .live-indicator {
            display: inline-flex; align-items: center; gap: 8px;
            padding: 8px 14px; font-size: 12px; font-weight: 600;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            border-radius: 6px;
            color: var(--vscode-foreground);
            letter-spacing: 0.5px;
        }
        .live-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #2ecc71;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.7); }
            50% { opacity: 0.8; box-shadow: 0 0 0 4px rgba(46, 204, 113, 0); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-top">
                <div>
                    <h1>Memory Regions</h1>
                    <div class="subtitle">Cosmos kernel memory layout and page allocator status</div>
                </div>
                <div class="header-actions">
                    <span class="live-indicator">
                        <span class="live-dot"></span>
                        LIVE
                    </span>
                </div>
            </div>
        </div>

        <div class="overview-grid">
            <div class="overview-card">
                <div class="overview-card-value">${formatBytes(pa.ramSize)}</div>
                <div class="overview-card-label">Heap Size</div>
            </div>
            <div class="overview-card">
                <div class="overview-card-value">${pa.totalPageCount.toLocaleString()}</div>
                <div class="overview-card-label">Total Pages</div>
            </div>
            <div class="overview-card">
                <div class="overview-card-value">${pa.freePageCount.toLocaleString()}</div>
                <div class="overview-card-label">Free Pages</div>
            </div>
            <div class="overview-card">
                <div class="overview-card-value">${usedPercent}%</div>
                <div class="overview-card-label">Usage</div>
            </div>
        </div>

        <!-- Limine Memory Map Section -->
        <div class="section collapsed" id="section-limine">
            <div class="section-title" onclick="toggleSection('section-limine')">
                <span>Limine Memory Map (${state.limineMemoryMap.length} entries)</span>
                <span class="chevron">▼</span>
            </div>
            <div class="section-content">
                <table>
                    <thead>
                        <tr><th></th><th>Base Address</th><th>Size</th><th>Type</th></tr>
                    </thead>
                    <tbody>
                        ${limineRows}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Page Allocator Section -->
        <div class="section" id="section-page-allocator">
            <div class="section-title" onclick="toggleSection('section-page-allocator')">
                <span>Page Allocator (RAT)</span>
                <span class="chevron">▼</span>
            </div>
            <div class="section-content">
                <div class="info-grid">
                    <div class="info-item">
                        <span class="info-label">RAM Start</span>
                        <span class="info-value mono">${pa.ramStart}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Heap End</span>
                        <span class="info-value mono">${pa.heapEnd}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">RAT Location</span>
                        <span class="info-value mono">${pa.ratLocation}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Page Size</span>
                        <span class="info-value">4 KB</span>
                    </div>
                </div>

                <div class="usage-bar">
                    <div class="usage-bar-fill" style="width: ${usedPercent}%;"></div>
                </div>

                <div style="font-size: 13px; font-weight: 500; margin-bottom: 12px;">Page Grid (first ${pa.pages.length} pages)</div>

                <div class="legend">
                    <div class="legend-item"><span class="legend-dot" style="background-color: #2ecc71;"></span>Empty</div>
                    <div class="legend-item"><span class="legend-dot" style="background-color: #3498db;"></span>HeapSmall</div>
                    <div class="legend-item"><span class="legend-dot" style="background-color: #9b59b6;"></span>HeapMedium</div>
                    <div class="legend-item"><span class="legend-dot" style="background-color: #e74c3c;"></span>HeapLarge</div>
                    <div class="legend-item"><span class="legend-dot" style="background-color: #e67e22;"></span>SMT</div>
                    <div class="legend-item"><span class="legend-dot" style="background-color: #7f8c8d;"></span>RAT</div>
                    <div class="legend-item"><span class="legend-dot" style="background-color: #95a5a6;"></span>Extension</div>
                </div>

                <div class="pages-grid">
                    ${pageGrid}
                </div>

                <div class="page-details" id="page-details">
                    <div class="page-details-placeholder">Hover over a page to see details</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            console.log('[Webview] Received message:', message.command);
            if (message.command === 'updateLiveStatus') {
                updateLiveIndicator(message.isLive);
            } else if (message.command === 'updateData') {
                console.log('[Webview] Updating data, timestamp:', message.data?.lastUpdated);
                updateMemoryData(message.data);
            }
        });

        function updateLiveIndicator(isLive) {
            const indicator = document.querySelector('.live-indicator');
            const dot = document.querySelector('.live-dot');
            if (!indicator || !dot) return;

            if (isLive) {
                indicator.innerHTML = '<span class="live-dot"></span>LIVE';
                dot.style.background = '#2ecc71';
                dot.style.animation = 'pulse 2s infinite';
            } else {
                indicator.innerHTML = '<span class="live-dot" style="background: #95a5a6; animation: none;"></span>DISCONNECTED';
            }
        }

        function updateMemoryData(state) {
            if (!state || !state.pageAllocator) {
                console.error('[Webview] Invalid state received:', state);
                return;
            }

            console.log('[Webview] Updating memory data...');
            const pa = state.pageAllocator;
            const usedPercent = ((pa.usedPageCount / pa.totalPageCount) * 100).toFixed(1);

            // Update overview cards
            const cards = document.querySelectorAll('.overview-card-value');
            console.log('[Webview] Found', cards.length, 'overview cards');
            if (cards[0]) cards[0].textContent = formatBytes(pa.ramSize);
            if (cards[1]) cards[1].textContent = pa.totalPageCount.toLocaleString();
            if (cards[2]) cards[2].textContent = pa.freePageCount.toLocaleString();
            if (cards[3]) cards[3].textContent = usedPercent + '%';
            console.log('[Webview] Updated overview: free pages =', pa.freePageCount);

            // Update pages grid - optimized to prevent flickering
            const grid = document.querySelector('.pages-grid');

            if (grid && pa.pages && pa.pages.length > 0) {
                const cells = grid.querySelectorAll('.page-cell');

                // If cell count changed, regenerate entire grid
                if (cells.length !== pa.pages.length) {
                    console.log('[Webview] Cell count changed, regenerating grid...');
                    grid.innerHTML = pa.pages.map(page => {
                        const color = getPageTypeColor(page.pageType);
                        return \`<div class="page-cell"
                            style="background-color: \${color};"
                            data-page-index="\${page.index}"
                            data-address="\${page.address}"
                            data-type="\${page.pageType}"
                            data-type-name="\${page.pageTypeName}"
                            data-size="\${page.size}"
                        ></div>\`;
                    }).join('');
                    attachPageHoverHandlers();
                } else {
                    // Only update cells that changed
                    let changedCount = 0;
                    pa.pages.forEach((page, i) => {
                        const cell = cells[i];
                        if (!cell) return;

                        const newColor = getPageTypeColor(page.pageType);
                        const oldType = cell.dataset.type;

                        // Only update if page type changed
                        if (oldType !== String(page.pageType)) {
                            cell.style.backgroundColor = newColor;
                            cell.dataset.type = String(page.pageType);
                            cell.dataset.typeName = page.pageTypeName;
                            cell.dataset.address = page.address;
                            cell.dataset.size = String(page.size);
                            changedCount++;
                        }
                    });
                    if (changedCount > 0) {
                        console.log('[Webview] Updated', changedCount, 'changed cells');
                    }
                }
            }
        }

        function attachPageHoverHandlers() {
            document.querySelectorAll('.page-cell').forEach(cell => {
                cell.addEventListener('mouseenter', function() {
                    const detailsDiv = document.getElementById('page-details');
                    if (!detailsDiv) return;

                    const pageIndex = this.dataset.pageIndex;
                    const address = this.dataset.address;
                    const typeName = this.dataset.typeName;
                    const size = this.dataset.size;

                    detailsDiv.innerHTML = \`
                        <div class="page-details-content">
                            <div class="info-item">
                                <span class="info-label">Page Index</span>
                                <span class="info-value">#\${pageIndex}</span>
                            </div>
                            <div class="info-item">
                                <span class="info-label">Address</span>
                                <span class="info-value mono">\${address}</span>
                            </div>
                            <div class="info-item">
                                <span class="info-label">Type</span>
                                <span class="info-value">\${typeName}</span>
                            </div>
                            <div class="info-item">
                                <span class="info-label">Size</span>
                                <span class="info-value">\${formatBytes(parseInt(size))}</span>
                            </div>
                        </div>
                    \`;
                });
            });
        }

        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
        }

        function getPageTypeColor(type) {
            const colors = {
                0: '#7f8c8d',  // Empty
                3: '#3498db',  // HeapSmall
                5: '#9b59b6',  // HeapMedium
                7: '#e74c3c',  // HeapLarge
                9: '#f39c12',  // Unmanaged
                11: '#2ecc71', // PageDirectory
                32: '#e67e22', // PageAllocator
                64: '#1abc9c', // SMT
                128: '#34495e' // Extension
            };
            return colors[type] || '#95a5a6';
        }

        function toggleSection(id) {
            const section = document.getElementById(id);
            if (section) section.classList.toggle('collapsed');
        }

        // Initial page hover handlers
        attachPageHoverHandlers();

        // Handle mouse leave from pages grid
        document.querySelector('.pages-grid')?.addEventListener('mouseleave', function() {
            const detailsDiv = document.getElementById('page-details');
            if (detailsDiv) {
                detailsDiv.innerHTML = '<div class="page-details-placeholder">Hover over a page to see details</div>';
            }
        });
    </script>
</body>
</html>`;
}
