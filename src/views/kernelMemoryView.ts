import * as vscode from 'vscode';
import { getOutputChannel } from '../utils/output';
import { getLiveReader } from '../debug/liveReader';

export interface MemoryStats {
    initialized: boolean;
    pageSize: number;
    ramStart: bigint;
    ramSize: bigint;
    totalPageCount: bigint;
    freePageCount: bigint;
    ratAddress: bigint;
    heapEnd: bigint;
    pagesEmpty: bigint;
    pagesGCHeap: bigint;
    pagesHeapSmall: bigint;
    pagesHeapMedium: bigint;
    pagesHeapLarge: bigint;
    pagesUnmanaged: bigint;
    pagesPageDirectory: bigint;
    pagesPageAllocator: bigint;
    pagesSMT: bigint;
    pagesExtension: bigint;
    pagesUnknown: bigint;
}

export interface PageExtent {
    /** First RAT index (also first page index relative to RamStart). */
    start: number;
    /** Number of pages in this extent (including coalesced Extension pages). */
    length: number;
    /** Owner PageType byte for this extent. Extension is coalesced into the owner. */
    type: number;
}

export interface MemoryUpdate {
    stats: MemoryStats | undefined;
    extents: PageExtent[] | undefined;
    extentsError: string | undefined;
    message: string | undefined;
}

// PageType values — keep in sync with kernel PageType.cs.
const PT_EMPTY = 0;
const PT_EXTENSION = 128;

// Snapshot layout — keep in sync with kernel DebugLiveMemorySnapshot.cs.
const MEM_SNAPSHOT_MAGIC = 0xC05D0003;
const MEM_SNAPSHOT_SIZE = 192;

function formatBytes(n: bigint): string {
    if (n < 1024n) return `${n} B`;
    const kb = Number(n) / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KiB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(2)} MiB`;
    return `${(mb / 1024).toFixed(2)} GiB`;
}

function formatHex(n: bigint): string {
    return `0x${n.toString(16).padStart(16, '0')}`;
}

function pagesAsBytes(pages: bigint, pageSize: number): bigint {
    return pages * BigInt(pageSize);
}

class MemoryMetricItem extends vscode.TreeItem {
    constructor(label: string, value: string, icon: string, tooltip?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = value;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'memoryMetric';
        if (tooltip) {
            this.tooltip = tooltip;
        }
    }
}

/**
 * Live memory-manager controller. Captures the kernel's
 * `CosmosDbg_GetMemorySnapshotAddr()` buffer address via the live reader,
 * polls it over QMP at 1 Hz, walks the RAT into coalesced extents and
 * fans out `MemoryUpdate` events to subscribers (the memory map webview).
 *
 * Doubles as the `TreeDataProvider` for the `cosmos.kernelMemory` view so
 * the heap-layout entries (Status, RAM start, …) render as native VS Code
 * tree items with the same controls as the GC and Threads views, instead
 * of as bespoke webview rows.
 */
export class KernelMemoryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidUpdate = new vscode.EventEmitter<MemoryUpdate>();
    readonly onDidUpdate = this._onDidUpdate.event;

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private stats: MemoryStats | undefined;
    private message: string | undefined;
    private snapshotAddr: bigint | undefined;
    private pollTimer: NodeJS.Timeout | undefined;
    private pollBusy = false;
    private extents: PageExtent[] | undefined;
    private extentsError: string | undefined;

    getLatest(): MemoryUpdate {
        return {
            stats: this.stats,
            extents: this.extents,
            extentsError: this.extentsError,
            message: this.message,
        };
    }

    setMessage(msg: string | undefined): void {
        this.message = msg;
        this.stats = undefined;
        this.extents = undefined;
        this.extentsError = undefined;
        this._onDidUpdate.fire(this.getLatest());
        this._onDidChangeTreeData.fire();
    }

    async captureSnapshotAddress(): Promise<boolean> {
        if (this.snapshotAddr !== undefined) {
            return true;
        }
        const log = getOutputChannel();
        const reader = getLiveReader();
        if (!reader || reader.memorySnapshotStaticsAddr === undefined) {
            return false;
        }
        try {
            const ptrBuf = await reader.readVirtual(reader.memorySnapshotStaticsAddr, 8);
            if (ptrBuf.length !== 8) {
                return false;
            }
            const lo = BigInt(ptrBuf.readUInt32LE(0));
            const hi = BigInt(ptrBuf.readUInt32LE(4));
            const addr = (hi << 32n) | lo;
            if (addr === 0n) {
                this.message = 'Memory snapshot not initialized yet.';
                this._onDidUpdate.fire(this.getLatest());
        this._onDidChangeTreeData.fire();
                return false;
            }
            this.snapshotAddr = addr;
            log.appendLine(`[kernel-memory] snapshot buffer at 0x${addr.toString(16)}`);
            this.message = 'Polling memory snapshot…';
            this._onDidUpdate.fire(this.getLatest());
        this._onDidChangeTreeData.fire();
            return true;
        } catch (e: any) {
            log.appendLine(`[kernel-memory] statics read failed: ${e?.message || e}`);
            return false;
        }
    }

    startPolling(intervalMs: number = 1000): void {
        if (this.pollTimer) {
            return;
        }
        this.pollTimer = setInterval(() => {
            void this.pollOnce();
        }, intervalMs);
    }

    stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    reset(): void {
        this.stopPolling();
        this.snapshotAddr = undefined;
        this.stats = undefined;
        this.extents = undefined;
        this.extentsError = undefined;
    }

    async refresh(): Promise<void> {
        await this.pollOnce();
    }

    private async pollOnce(): Promise<void> {
        if (this.pollBusy) {
            return;
        }
        if (this.snapshotAddr === undefined) {
            return;
        }
        const reader = getLiveReader();
        if (!reader) {
            return;
        }
        this.pollBusy = true;
        try {
            // Retry the seqlock read a few times — the kernel writes the
            // snapshot from the timer-tick path, so a single poll can land
            // while seq is odd (writer in-progress) and we'd see null. A
            // tiny gap between attempts lets the writer finish.
            let parsed: MemoryStats | null = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                const buf = await reader.readVirtual(this.snapshotAddr, MEM_SNAPSHOT_SIZE);
                parsed = parseMemorySnapshot(buf);
                if (parsed) break;
                if (attempt < 2) {
                    await new Promise(resolve => setTimeout(resolve, 30));
                }
            }
            if (!parsed) {
                // Transient seqlock collision (or buffer not yet written by
                // the kernel). Keep the last good snapshot so the UI doesn't
                // flicker; only surface the "not populated" message if we
                // have nothing to show yet.
                if (!this.stats) {
                    this.message = 'Memory snapshot buffer not yet populated.';
                    this._onDidUpdate.fire(this.getLatest());
                    this._onDidChangeTreeData.fire();
                }
                return;
            }
            this.message = undefined;
            this.stats = parsed;
            if (parsed.initialized) {
                await this.refreshExtents(reader, parsed);
            }
            this._onDidUpdate.fire(this.getLatest());
            this._onDidChangeTreeData.fire();
        } catch (e: any) {
            const log = getOutputChannel();
            log.appendLine(`[kernel-memory] poll error: ${e?.message || e}`);
        } finally {
            this.pollBusy = false;
        }
    }

    private async refreshExtents(reader: NonNullable<ReturnType<typeof getLiveReader>>, stats: MemoryStats): Promise<void> {
        const log = getOutputChannel();
        const ratAddr = stats.ratAddress;
        const total = Number(stats.totalPageCount);
        if (ratAddr === 0n || total === 0) {
            return;
        }
        try {
            const ratBuf = await reader.readVirtual(ratAddr, total);
            if (ratBuf.length !== total) {
                this.extentsError = `Short RAT read: got ${ratBuf.length}/${total} bytes`;
                return;
            }
            this.extents = walkExtents(ratBuf);
            this.extentsError = undefined;
        } catch (e: any) {
            this.extentsError = `RAT read failed: ${e?.message || e}`;
            log.appendLine(`[kernel-memory] ${this.extentsError}`);
        }
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    getChildren(): vscode.TreeItem[] {
        if (!this.stats) {
            const placeholder = new vscode.TreeItem(
                this.message ?? 'Waiting for memory snapshot…',
                vscode.TreeItemCollapsibleState.None
            );
            placeholder.iconPath = new vscode.ThemeIcon('info');
            return [placeholder];
        }
        const s = this.stats;
        const ps = s.pageSize;
        const used = s.totalPageCount - s.freePageCount;
        const items: vscode.TreeItem[] = [];
        items.push(new MemoryMetricItem('Status', s.initialized ? 'initialized' : 'not initialized',
            s.initialized ? 'pass' : 'circle-outline'));
        items.push(new MemoryMetricItem('Page size', `${ps} B`, 'symbol-ruler'));
        items.push(new MemoryMetricItem('RAM start', formatHex(s.ramStart), 'arrow-right',
            'Base of the heap data area.'));
        items.push(new MemoryMetricItem('RAM size', formatBytes(s.ramSize), 'database',
            'Heap data area only (RAT pages excluded).'));
        items.push(new MemoryMetricItem('RAT address', formatHex(s.ratAddress), 'list-flat',
            'Region Allocation Table base. By design the RAT sits at the end of the heap, so this is also where the heap ends.'));
        items.push(new MemoryMetricItem('Total pages', s.totalPageCount.toString(), 'symbol-numeric'));
        items.push(new MemoryMetricItem('Free pages',
            `${s.freePageCount} (${formatBytes(pagesAsBytes(s.freePageCount, ps))})`, 'check'));
        items.push(new MemoryMetricItem('Used pages',
            `${used} (${formatBytes(pagesAsBytes(used, ps))})`, 'graph'));
        return items;
    }

    serialize(): string {
        const lines: string[] = [];
        if (this.message) {
            lines.push(this.message);
        }
        if (!this.stats) {
            if (!this.message) lines.push('(no data)');
            return lines.join('\n');
        }
        const s = this.stats;
        const usedPages = s.totalPageCount - s.freePageCount;
        const usedBytes = pagesAsBytes(usedPages, s.pageSize);
        const freeBytes = pagesAsBytes(s.freePageCount, s.pageSize);
        lines.push(`Initialized:        ${s.initialized}`);
        lines.push(`Page size:          ${s.pageSize} B`);
        lines.push(`RAM start:          ${formatHex(s.ramStart)}`);
        lines.push(`RAM size:           ${formatBytes(s.ramSize)}`);
        lines.push(`Heap end:           ${formatHex(s.heapEnd)}`);
        lines.push(`RAT address:        ${formatHex(s.ratAddress)}`);
        lines.push(`Total pages:        ${s.totalPageCount}`);
        lines.push(`Free pages:         ${s.freePageCount} (${formatBytes(freeBytes)})`);
        lines.push(`Used pages:         ${usedPages} (${formatBytes(usedBytes)})`);
        lines.push('Page composition:');
        lines.push(`  Empty:            ${s.pagesEmpty} (${formatBytes(pagesAsBytes(s.pagesEmpty, s.pageSize))})`);
        lines.push(`  GCHeap:           ${s.pagesGCHeap} (${formatBytes(pagesAsBytes(s.pagesGCHeap, s.pageSize))})`);
        lines.push(`  HeapSmall:        ${s.pagesHeapSmall} (${formatBytes(pagesAsBytes(s.pagesHeapSmall, s.pageSize))})`);
        lines.push(`  HeapMedium:       ${s.pagesHeapMedium} (${formatBytes(pagesAsBytes(s.pagesHeapMedium, s.pageSize))})`);
        lines.push(`  HeapLarge:        ${s.pagesHeapLarge} (${formatBytes(pagesAsBytes(s.pagesHeapLarge, s.pageSize))})`);
        lines.push(`  Unmanaged:        ${s.pagesUnmanaged} (${formatBytes(pagesAsBytes(s.pagesUnmanaged, s.pageSize))})`);
        lines.push(`  PageDirectory:    ${s.pagesPageDirectory} (${formatBytes(pagesAsBytes(s.pagesPageDirectory, s.pageSize))})`);
        lines.push(`  PageAllocator:    ${s.pagesPageAllocator} (${formatBytes(pagesAsBytes(s.pagesPageAllocator, s.pageSize))})`);
        lines.push(`  SMT:              ${s.pagesSMT} (${formatBytes(pagesAsBytes(s.pagesSMT, s.pageSize))})`);
        lines.push(`  Extension:        ${s.pagesExtension} (${formatBytes(pagesAsBytes(s.pagesExtension, s.pageSize))})`);
        if (s.pagesUnknown > 0n) {
            lines.push(`  Unknown:          ${s.pagesUnknown}`);
        }
        return lines.join('\n');
    }
}

/**
 * Walks the raw RAT bytes and emits coalesced extents. Each non-Extension
 * page byte starts a new extent; following Extension bytes are folded in.
 * Empty pages coalesce with adjacent Empty pages (since they don't carry
 * Extension markers in the RAT). Orphan Extension runs are emitted as
 * their own extents — they shouldn't occur in a healthy RAT but we don't
 * silently drop them so a corrupted RAT shows up in the view.
 */
function walkExtents(rat: Buffer): PageExtent[] {
    const out: PageExtent[] = [];
    const n = rat.length;
    let i = 0;
    while (i < n) {
        const t = rat[i];
        const start = i;
        if (t === PT_EXTENSION) {
            while (i < n && rat[i] === PT_EXTENSION) i++;
            out.push({ start, length: i - start, type: PT_EXTENSION });
            continue;
        }
        i++;
        if (t === PT_EMPTY) {
            while (i < n && rat[i] === PT_EMPTY) i++;
        } else {
            while (i < n && rat[i] === PT_EXTENSION) i++;
        }
        out.push({ start, length: i - start, type: t });
    }
    return out;
}

function parseMemorySnapshot(buf: Buffer): MemoryStats | null {
    if (buf.length < 160) {
        return null;
    }
    const magic = buf.readUInt32LE(0);
    if (magic !== MEM_SNAPSHOT_MAGIC) {
        return null;
    }
    const seqLo = buf.readUInt32LE(16);
    const seqHi = buf.readUInt32LE(20);
    const seq = (BigInt(seqHi) << 32n) | BigInt(seqLo);
    if ((seq & 1n) !== 0n) {
        return null;
    }
    const flags = buf.readUInt32LE(8);
    return {
        initialized: (flags & 1) !== 0,
        pageSize: buf.readUInt32LE(12),
        ramStart: buf.readBigUInt64LE(24),
        ramSize: buf.readBigUInt64LE(32),
        totalPageCount: buf.readBigUInt64LE(40),
        freePageCount: buf.readBigUInt64LE(48),
        ratAddress: buf.readBigUInt64LE(56),
        heapEnd: buf.readBigUInt64LE(64),
        pagesEmpty: buf.readBigUInt64LE(72),
        pagesGCHeap: buf.readBigUInt64LE(80),
        pagesHeapSmall: buf.readBigUInt64LE(88),
        pagesHeapMedium: buf.readBigUInt64LE(96),
        pagesHeapLarge: buf.readBigUInt64LE(104),
        pagesUnmanaged: buf.readBigUInt64LE(112),
        pagesPageDirectory: buf.readBigUInt64LE(120),
        pagesPageAllocator: buf.readBigUInt64LE(128),
        pagesSMT: buf.readBigUInt64LE(136),
        pagesExtension: buf.readBigUInt64LE(144),
        pagesUnknown: buf.readBigUInt64LE(152),
    };
}

/**
 * DebugAdapterTrackerFactory hook. Starts the QMP poll loop as soon as
 * the live reader's memory-statics address resolves.
 */
export class KernelMemoryTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    constructor(private readonly provider: KernelMemoryProvider) { }

    createDebugAdapterTracker(_session: vscode.DebugSession): vscode.DebugAdapterTracker {
        const provider = this.provider;
        let captureDone = false;
        let retryTimer: NodeJS.Timeout | undefined;

        const tryCapture = async () => {
            if (captureDone) {
                return;
            }
            const ok = await provider.captureSnapshotAddress();
            if (ok) {
                captureDone = true;
                provider.startPolling(1000);
                if (retryTimer) {
                    clearInterval(retryTimer);
                    retryTimer = undefined;
                }
            }
        };

        setTimeout(tryCapture, 1500);
        retryTimer = setInterval(tryCapture, 1500);

        return {
            onDidSendMessage(msg: any) {
                if (!msg || msg.type !== 'event') {
                    return;
                }
                if (msg.event === 'terminated' || msg.event === 'exited') {
                    if (retryTimer) {
                        clearInterval(retryTimer);
                        retryTimer = undefined;
                    }
                    provider.reset();
                    provider.setMessage('Debug session ended.');
                    captureDone = false;
                }
            }
        };
    }
}
