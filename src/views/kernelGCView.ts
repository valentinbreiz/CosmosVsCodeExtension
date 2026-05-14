import * as vscode from 'vscode';
import { getOutputChannel } from '../utils/output';
import { getLiveReader } from '../debug/liveReader';

interface GCStats {
    initialized: boolean;
    heapSizeBytes: bigint;
    fragmentedBytes: bigint;
    totalCommittedBytes: bigint;
    totalAllocatedBytes: bigint;
    pinnedObjectsCount: bigint;
    collectionCount: number;
    totalObjectsFreed: number;
    memoryLoadBytes: bigint;
    gcSegmentSize: bigint;
    lastGCPercentTimeInGC: number;
    lastGen0SizeBefore: bigint;
    lastGen0FragBefore: bigint;
    lastGen0SizeAfter: bigint;
    lastGen0FragAfter: bigint;
}

// Snapshot layout — keep in sync with kernel DebugLiveGCSnapshot.cs.
const GC_SNAPSHOT_MAGIC = 0xC05D0002;
const GC_SNAPSHOT_SIZE = 160;

function formatBytes(n: bigint): string {
    if (n < 1024n) return `${n} B`;
    const kb = Number(n) / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KiB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(2)} MiB`;
    return `${(mb / 1024).toFixed(2)} GiB`;
}

class GCMetricItem extends vscode.TreeItem {
    constructor(label: string, value: string, icon: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = value;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'gcMetric';
    }
}

/**
 * Live garbage-collector view backed by a QMP memory read of the kernel's
 * `CosmosDbg_GetGCSnapshotAddr()` buffer. Mirrors the kernel-threads view:
 * snapshot is captured once via the statics symbol address, then polled
 * over QMP without pausing the guest.
 */
export class KernelGCProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    private stats: GCStats | undefined;
    private message: string | undefined;
    private snapshotAddr: bigint | undefined;
    private pollTimer: NodeJS.Timeout | undefined;
    private pollBusy = false;

    setMessage(msg: string | undefined): void {
        this.message = msg;
        this.stats = undefined;
        this._onDidChange.fire();
    }

    /**
     * Captures the kernel-side snapshot buffer address. Uses the QMP
     * statics-symbol path; no gdb infcall fallback because the timer-tick
     * update is the only way the buffer gets data and that runs without
     * needing the inferior paused.
     */
    async captureSnapshotAddress(): Promise<boolean> {
        if (this.snapshotAddr !== undefined) {
            return true;
        }
        const log = getOutputChannel();
        const reader = getLiveReader();
        if (!reader || reader.gcSnapshotStaticsAddr === undefined) {
            return false;
        }
        try {
            const ptrBuf = await reader.readVirtual(reader.gcSnapshotStaticsAddr, 8);
            if (ptrBuf.length !== 8) {
                return false;
            }
            const lo = BigInt(ptrBuf.readUInt32LE(0));
            const hi = BigInt(ptrBuf.readUInt32LE(4));
            const addr = (hi << 32n) | lo;
            if (addr === 0n) {
                this.message = 'GC snapshot not initialized yet.';
                this._onDidChange.fire();
                return false;
            }
            this.snapshotAddr = addr;
            log.appendLine(`[kernel-gc] snapshot buffer at 0x${addr.toString(16)}`);
            this.message = 'Polling GC snapshot…';
            this._onDidChange.fire();
            return true;
        } catch (e: any) {
            log.appendLine(`[kernel-gc] statics read failed: ${e?.message || e}`);
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
    }

    async refresh(): Promise<void> {
        await this.pollOnce();
        this._onDidChange.fire();
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
            const buf = await reader.readVirtual(this.snapshotAddr, GC_SNAPSHOT_SIZE);
            const parsed = parseGCSnapshot(buf);
            if (!parsed) {
                this.message = 'GC snapshot buffer not yet populated.';
                this.stats = undefined;
            } else {
                this.message = undefined;
                this.stats = parsed;
            }
            this._onDidChange.fire();
        } catch (e: any) {
            const log = getOutputChannel();
            log.appendLine(`[kernel-gc] poll error: ${e?.message || e}`);
        } finally {
            this.pollBusy = false;
        }
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
        lines.push(`Initialized:           ${s.initialized}`);
        lines.push(`Heap size:             ${formatBytes(s.heapSizeBytes)}`);
        lines.push(`Fragmented:            ${formatBytes(s.fragmentedBytes)}`);
        lines.push(`Total committed:       ${formatBytes(s.totalCommittedBytes)}`);
        lines.push(`Total allocated:       ${formatBytes(s.totalAllocatedBytes)}`);
        lines.push(`Pinned objects:        ${s.pinnedObjectsCount}`);
        lines.push(`Collections:           ${s.collectionCount}`);
        lines.push(`Objects freed (total): ${s.totalObjectsFreed}`);
        lines.push(`Memory load:           ${formatBytes(s.memoryLoadBytes)}`);
        lines.push(`Segment size:          ${formatBytes(s.gcSegmentSize)}`);
        lines.push(`Last GC %time-in-GC:   ${s.lastGCPercentTimeInGC}%`);
        lines.push(`Last gen0 before:      size=${formatBytes(s.lastGen0SizeBefore)} frag=${formatBytes(s.lastGen0FragBefore)}`);
        lines.push(`Last gen0 after:       size=${formatBytes(s.lastGen0SizeAfter)} frag=${formatBytes(s.lastGen0FragAfter)}`);
        return lines.join('\n');
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    getChildren(): vscode.TreeItem[] {
        if (!this.stats) {
            const placeholder = new vscode.TreeItem(
                this.message ?? 'Waiting for GC snapshot…',
                vscode.TreeItemCollapsibleState.None
            );
            placeholder.iconPath = new vscode.ThemeIcon('info');
            return [placeholder];
        }
        const s = this.stats;
        const items: vscode.TreeItem[] = [];
        items.push(new GCMetricItem('Status', s.initialized ? 'initialized' : 'not initialized',
            s.initialized ? 'pass' : 'circle-outline'));
        items.push(new GCMetricItem('Heap size', formatBytes(s.heapSizeBytes), 'database'));
        items.push(new GCMetricItem('Fragmented', formatBytes(s.fragmentedBytes), 'symbol-misc'));
        items.push(new GCMetricItem('Total committed', formatBytes(s.totalCommittedBytes), 'archive'));
        items.push(new GCMetricItem('Total allocated', formatBytes(s.totalAllocatedBytes), 'graph'));
        items.push(new GCMetricItem('Pinned objects', s.pinnedObjectsCount.toString(), 'pinned'));
        items.push(new GCMetricItem('Collections', s.collectionCount.toString(), 'sync'));
        items.push(new GCMetricItem('Objects freed', s.totalObjectsFreed.toString(), 'trash'));
        items.push(new GCMetricItem('Memory load', formatBytes(s.memoryLoadBytes), 'pulse'));
        items.push(new GCMetricItem('Segment size', formatBytes(s.gcSegmentSize), 'layers'));
        items.push(new GCMetricItem('Last GC %time-in-GC', `${s.lastGCPercentTimeInGC}%`, 'watch'));
        items.push(new GCMetricItem('Last gen0 size (before)', formatBytes(s.lastGen0SizeBefore), 'arrow-up'));
        items.push(new GCMetricItem('Last gen0 frag (before)', formatBytes(s.lastGen0FragBefore), 'arrow-up'));
        items.push(new GCMetricItem('Last gen0 size (after)', formatBytes(s.lastGen0SizeAfter), 'arrow-down'));
        items.push(new GCMetricItem('Last gen0 frag (after)', formatBytes(s.lastGen0FragAfter), 'arrow-down'));
        return items;
    }
}

/**
 * Parses the kernel GC snapshot buffer. Validates magic + applies the
 * seqlock check — if seq is odd we caught a writer mid-update so we
 * return null and the caller skips this poll.
 */
function parseGCSnapshot(buf: Buffer): GCStats | null {
    if (buf.length < 136) {
        return null;
    }
    const magic = buf.readUInt32LE(0);
    if (magic !== GC_SNAPSHOT_MAGIC) {
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
        heapSizeBytes: buf.readBigUInt64LE(24),
        fragmentedBytes: buf.readBigUInt64LE(32),
        totalCommittedBytes: buf.readBigUInt64LE(40),
        totalAllocatedBytes: buf.readBigUInt64LE(48),
        pinnedObjectsCount: buf.readBigUInt64LE(56),
        collectionCount: buf.readUInt32LE(64),
        totalObjectsFreed: buf.readUInt32LE(68),
        memoryLoadBytes: buf.readBigUInt64LE(72),
        gcSegmentSize: buf.readBigUInt64LE(80),
        lastGCPercentTimeInGC: buf.readUInt32LE(96),
        lastGen0SizeBefore: buf.readBigUInt64LE(104),
        lastGen0FragBefore: buf.readBigUInt64LE(112),
        lastGen0SizeAfter: buf.readBigUInt64LE(120),
        lastGen0FragAfter: buf.readBigUInt64LE(128)
    };
}

/**
 * DebugAdapterTrackerFactory hook. Starts the QMP poll loop as soon as
 * the live reader's GC-statics address resolves; no gdb-stop required.
 */
export class KernelGCTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    constructor(private readonly provider: KernelGCProvider) { }

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
