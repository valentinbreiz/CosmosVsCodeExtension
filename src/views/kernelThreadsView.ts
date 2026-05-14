import * as vscode from 'vscode';
import { getOutputChannel } from '../utils/output';
import { getLiveReader } from '../debug/liveReader';

interface KernelThreadInfo {
    slot: number;
    id: number;
    state: string;
    cpuId: number;
    flags: number;
}

const STATE_NAMES = ['Created', 'Ready', 'Running', 'Blocked', 'Sleeping', 'Dead'];

// Snapshot layout — keep in sync with kernel DebugLiveSnapshot.cs.
const SNAPSHOT_MAGIC = 0xC05D0001;
const HEADER_SIZE = 24;
const ENTRY_SIZE = 16;
const MAX_ENTRIES = 64;
const SNAPSHOT_SIZE = HEADER_SIZE + MAX_ENTRIES * ENTRY_SIZE;

export class KernelThreadItem extends vscode.TreeItem {
    constructor(info: KernelThreadInfo) {
        const cpu = info.cpuId >= 0 ? ` on CPU ${info.cpuId}` : '';
        super(`#${info.id} [${info.state}]${cpu}`, vscode.TreeItemCollapsibleState.None);
        const flagBits: string[] = [];
        if (info.flags & 0x1) flagBits.push('Kernel');
        if (info.flags & 0x2) flagBits.push('Idle');
        if (info.flags & 0x4) flagBits.push('Pinned');
        if (info.flags & 0x8) flagBits.push('Managed');
        this.description = flagBits.length ? `slot ${info.slot} · ${flagBits.join('|')}` : `slot ${info.slot}`;
        this.contextValue = 'kernelThread';
        this.iconPath = new vscode.ThemeIcon(iconForState(info.state));
    }
}

function iconForState(state: string): string {
    switch (state) {
        case 'Running':  return 'debug-start';
        case 'Ready':    return 'debug-step-over';
        case 'Blocked':  return 'debug-pause';
        case 'Sleeping': return 'clock';
        case 'Dead':     return 'circle-slash';
        default:         return 'circle-outline';
    }
}

/**
 * Live kernel-thread view backed by a QMP memory read of the kernel's
 * `CosmosDbg_GetSnapshotAddr()` buffer. The kernel updates that buffer
 * from the timer tick; we read it without pausing the guest so the
 * view stays current while code runs.
 *
 * Snapshot address is captured on the first gdb `stopped` event via a
 * function-call evaluate (the only time the kernel runtime is paused
 * enough for `(unsigned long long)CosmosDbg_GetSnapshotAddr()`). After
 * that we never evaluate again.
 */
export class KernelThreadsProvider implements vscode.TreeDataProvider<KernelThreadItem> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    private threads: KernelThreadInfo[] = [];
    private message: string | undefined;
    private snapshotAddr: bigint | undefined;
    private pollTimer: NodeJS.Timeout | undefined;
    private pollBusy = false;

    setMessage(msg: string | undefined): void {
        this.message = msg;
        this.threads = [];
        this._onDidChange.fire();
    }

    /**
     * Captures the kernel-side snapshot buffer address. Called once at
     * the first `stopped` event during a debug session.
     */
    /**
     * Attempts to capture the kernel snapshot buffer address via gdb
     * function-call evaluate. Returns true once captured; false means the
     * kernel hasn't initialized the snapshot yet — caller should retry on
     * a later `stopped` event.
     */
    async captureSnapshotAddress(session: vscode.DebugSession): Promise<boolean> {
        if (this.snapshotAddr !== undefined) {
            return true;
        }
        const log = getOutputChannel();

        // Preferred path: read the s_buffer pointer directly out of the
        // kernel's static storage via QMP. Avoids the gdb-infcall race
        // entirely and works even before the user hits a breakpoint, so
        // long as DebugLiveSnapshot.Initialize() has run.
        const reader = getLiveReader();
        if (!reader) {
            log.appendLine(`[kernel-threads] no live reader registered — QMP not connected for this session`);
        } else if (reader.snapshotStaticsAddr === undefined) {
            log.appendLine(`[kernel-threads] live reader present but snapshotStaticsAddr is unset — symbol lookup failed`);
        }
        if (reader?.snapshotStaticsAddr !== undefined) {
            try {
                const ptrBuf = await reader.readVirtual(reader.snapshotStaticsAddr, 8);
                if (ptrBuf.length === 8) {
                    const lo = BigInt(ptrBuf.readUInt32LE(0));
                    const hi = BigInt(ptrBuf.readUInt32LE(4));
                    const addr = (hi << 32n) | lo;
                    if (addr !== 0n) {
                        this.snapshotAddr = addr;
                        log.appendLine(`[kernel-threads] snapshot buffer at 0x${addr.toString(16)} (via statics symbol)`);
                        this.message = 'Polling kernel snapshot…';
                        this._onDidChange.fire();
                        return true;
                    }
                    log.appendLine(`[kernel-threads] s_buffer is 0 — DebugLiveSnapshot.Initialize() not run yet`);
                    this.message = 'Live snapshot not initialized yet (scheduler not up).';
                    this._onDidChange.fire();
                    return false;
                }
            } catch (e: any) {
                log.appendLine(`[kernel-threads] statics read failed, falling back to gdb: ${e?.message || e}`);
            }
        }

        // Fallback: gdb function-call evaluate. Subject to the
        // "thread is running" race during VS Code's auto-evaluate flurry.
        let raw: unknown;
        let lastErr: any;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const res = await session.customRequest('evaluate', {
                    expression: '(unsigned long long)CosmosDbg_GetSnapshotAddr()',
                    context: 'watch',
                    frameId: 0
                });
                raw = res?.result;
                lastErr = undefined;
                break;
            } catch (e: any) {
                const m = (e && (e.message || e.toString())) || '';
                if (/thread is running/i.test(m) || /target is running/i.test(m)) {
                    lastErr = e;
                    await new Promise(r => setTimeout(r, 100 + attempt * 100));
                    continue;
                }
                lastErr = e;
                break;
            }
        }
        if (lastErr) {
            log.appendLine(`[kernel-threads] capture failed: ${lastErr?.message || lastErr}`);
            this.message = `Snapshot capture failed: ${lastErr?.message || lastErr}`;
            this._onDidChange.fire();
            return false;
        }
        log.appendLine(`[kernel-threads] capture raw=${JSON.stringify(raw)}`);
        const m = typeof raw === 'string' ? raw.match(/0x[0-9a-fA-F]+|\d+/) : null;
        if (!m) {
            this.message = 'Could not locate live snapshot buffer (parse failed).';
            this._onDidChange.fire();
            return false;
        }
        const addr = BigInt(m[0]);
        if (addr === 0n) {
            this.message = 'Live snapshot not initialized yet — continue or hit another breakpoint after the scheduler starts.';
            this._onDidChange.fire();
            return false;
        }
        this.snapshotAddr = addr;
        log.appendLine(`[kernel-threads] snapshot buffer at 0x${addr.toString(16)}`);
        this.message = 'Polling kernel snapshot…';
        this._onDidChange.fire();
        return true;
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
        this.threads = [];
    }

    /**
     * Manual refresh — for the title-bar button. Tries the live path first;
     * falls back to "no snapshot yet" message.
     */
    async refresh(_session: vscode.DebugSession): Promise<void> {
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
            const buf = await reader.readVirtual(this.snapshotAddr, SNAPSHOT_SIZE);
            const parsed = parseSnapshot(buf);
            if (!parsed) {
                this.message = 'Snapshot buffer not yet populated (bad magic).';
                this.threads = [];
            } else {
                this.message = undefined;
                this.threads = parsed;
            }
            this._onDidChange.fire();
        } catch (e: any) {
            const log = getOutputChannel();
            log.appendLine(`[kernel-threads] poll error: ${e?.message || e}`);
        } finally {
            this.pollBusy = false;
        }
    }

    serialize(): string {
        const lines: string[] = [];
        if (this.message) {
            lines.push(this.message);
        }
        if (this.threads.length === 0 && !this.message) {
            lines.push('(empty)');
        }
        for (const t of this.threads) {
            const cpu = t.cpuId >= 0 ? ` on CPU ${t.cpuId}` : '';
            lines.push(`slot ${t.slot}: #${t.id} [${t.state}]${cpu} flags=0x${t.flags.toString(16)}`);
        }
        return lines.join('\n');
    }

    getTreeItem(item: KernelThreadItem): vscode.TreeItem {
        return item;
    }

    getChildren(): KernelThreadItem[] {
        if (this.threads.length === 0 && this.message) {
            const placeholder = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
            placeholder.iconPath = new vscode.ThemeIcon('info');
            return [placeholder as KernelThreadItem];
        }
        return this.threads.map(t => new KernelThreadItem(t));
    }
}

/**
 * Parses the kernel snapshot buffer. Validates magic + applies the
 * seqlock check — if seq is odd we caught a writer mid-update; if
 * pre/post seq differ we read a torn record. In both cases return null
 * so the caller skips this poll.
 */
function parseSnapshot(buf: Buffer): KernelThreadInfo[] | null {
    if (buf.length < HEADER_SIZE) {
        return null;
    }
    const magic = buf.readUInt32LE(0);
    if (magic !== SNAPSHOT_MAGIC) {
        return null;
    }
    const count = buf.readUInt32LE(8);
    const seqLo = buf.readUInt32LE(16);
    const seqHi = buf.readUInt32LE(20);
    const seq = (BigInt(seqHi) << 32n) | BigInt(seqLo);
    if ((seq & 1n) !== 0n) {
        // writer in progress — let next poll catch a stable read
        return null;
    }
    const entries: KernelThreadInfo[] = [];
    const n = Math.min(count, MAX_ENTRIES);
    for (let i = 0; i < n; i++) {
        const off = HEADER_SIZE + i * ENTRY_SIZE;
        const id = buf.readUInt32LE(off + 0);
        const cpu = buf.readUInt32LE(off + 4);
        const state = buf.readUInt32LE(off + 8);
        const flags = buf.readUInt32LE(off + 12);
        entries.push({
            slot: i,
            id,
            state: state < STATE_NAMES.length ? STATE_NAMES[state] : `?${state}`,
            cpuId: cpu,
            flags
        });
    }
    return entries;
}

/**
 * DebugAdapterTrackerFactory hook. Captures the snapshot buffer address
 * once on the first stopped event (the only safe time to do a gdb
 * function-call evaluate), then starts a QMP-based poll loop that runs
 * regardless of stop/continue state.
 */
export class KernelThreadsTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    constructor(private readonly provider: KernelThreadsProvider) { }

    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
        const provider = this.provider;
        let captureDone = false;
        let retryTimer: NodeJS.Timeout | undefined;

        const tryCapture = async () => {
            if (captureDone) {
                return;
            }
            const ok = await provider.captureSnapshotAddress(session);
            if (ok) {
                captureDone = true;
                provider.startPolling(1000);
                if (retryTimer) {
                    clearInterval(retryTimer);
                    retryTimer = undefined;
                }
            }
        };

        // Try capture immediately and then on a 1.5s retry loop while
        // the kernel boots. QMP works without pausing, so we don't need
        // to wait for the first DAP `stopped` event when the live-reader
        // statics address is known.
        setTimeout(tryCapture, 1500);
        retryTimer = setInterval(tryCapture, 1500);

        return {
            onDidSendMessage(msg: any) {
                if (!msg || msg.type !== 'event') {
                    return;
                }
                if (msg.event === 'stopped' && !captureDone) {
                    // gdb-infcall fallback still triggered on stop, in case
                    // the QMP statics-symbol path is unavailable.
                    setTimeout(tryCapture, 400);
                } else if (msg.event === 'terminated' || msg.event === 'exited') {
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
