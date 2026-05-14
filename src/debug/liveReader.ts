/**
 * Module-level handle to the active session's "live kernel memory reader".
 * Backed by QMP today — reads guest virtual memory without pausing the
 * inferior. Views (Kernel Threads, etc.) call getLiveReader() to fetch
 * the active reader; absence means the session has no live channel.
 */
export interface LiveReader {
    readVirtual(vaddr: bigint, length: number): Promise<Buffer>;
    /**
     * Address of the DebugLiveSnapshot non-GC statics block. The first
     * 8 bytes at this address hold the snapshot buffer pointer (the
     * `s_buffer` field). When set, views can skip the gdb infcall.
     */
    snapshotStaticsAddr?: bigint;
    /**
     * Same idea for DebugLiveGCSnapshot — first 8 bytes hold its
     * `s_buffer` pointer.
     */
    gcSnapshotStaticsAddr?: bigint;
}

let active: LiveReader | undefined;

export function registerLiveReader(reader: LiveReader): void {
    active = reader;
}

export function unregisterLiveReader(): void {
    active = undefined;
}

export function getLiveReader(): LiveReader | undefined {
    return active;
}
