import * as net from 'net';

/**
 * Minimal QEMU Machine Protocol client. Speaks the JSON line-delimited
 * protocol just enough to: complete the QMP handshake, send
 * `human-monitor-command` with `xp` (physical memory) or `x` (virtual)
 * reads while the guest is running, and parse the textual response into
 * raw bytes.
 *
 * QMP is independent of the gdbstub, so reads here don't pause the guest.
 */
export class QmpClient {
    private socket: net.Socket | undefined;
    private rxBuf = '';
    private readonly pending: { resolve: (v: any) => void; reject: (e: any) => void }[] = [];
    private ready = false;
    private connectPromise: Promise<void> | undefined;

    constructor(private readonly host: string, private readonly port: number) { }

    connect(timeoutMs: number = 5000): Promise<void> {
        if (this.connectPromise) {
            return this.connectPromise;
        }
        this.connectPromise = new Promise<void>((resolve, reject) => {
            const sock = net.createConnection({ host: this.host, port: this.port });
            this.socket = sock;
            const timer = setTimeout(() => {
                sock.destroy();
                reject(new Error(`QMP connect timeout (${this.host}:${this.port})`));
            }, timeoutMs);
            sock.once('error', err => {
                clearTimeout(timer);
                reject(err);
            });
            sock.once('connect', async () => {
                clearTimeout(timer);
                sock.on('data', d => this.onData(d.toString('utf8')));
                sock.on('close', () => this.onClose());
                try {
                    // Wait for greeting then send qmp_capabilities.
                    await this.waitForGreeting(5000);
                    await this.send({ execute: 'qmp_capabilities' });
                    this.ready = true;
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        return this.connectPromise;
    }

    isReady(): boolean {
        return this.ready;
    }

    dispose(): void {
        this.ready = false;
        if (this.socket) {
            this.socket.destroy();
            this.socket = undefined;
        }
        for (const p of this.pending) {
            p.reject(new Error('QMP closed'));
        }
        this.pending.length = 0;
    }

    /**
     * Reads `length` bytes of guest VIRTUAL memory at `vaddr` via QEMU's
     * HMP `x` command (uses the current vCPU's MMU). The guest does not
     * pause for this. Returns the raw bytes.
     */
    async readVirtual(vaddr: bigint, length: number): Promise<Buffer> {
        const cmd = `x /${length}bx 0x${vaddr.toString(16)}`;
        const res = await this.send({
            execute: 'human-monitor-command',
            arguments: { 'command-line': cmd }
        });
        if (typeof res.return !== 'string') {
            throw new Error(`x returned non-string: ${JSON.stringify(res)}`);
        }
        return parseMonitorHexDump(res.return, length);
    }

    private greetingResolvers: Array<(g: any) => void> = [];
    private receivedGreeting: any = undefined;

    private waitForGreeting(timeoutMs: number): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.receivedGreeting !== undefined) {
                resolve(this.receivedGreeting);
                return;
            }
            const timer = setTimeout(() => reject(new Error('QMP greeting timeout')), timeoutMs);
            this.greetingResolvers.push(g => {
                clearTimeout(timer);
                resolve(g);
            });
        });
    }

    private send(obj: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('QMP not connected'));
                return;
            }
            this.pending.push({ resolve, reject });
            this.socket.write(JSON.stringify(obj) + '\n');
        });
    }

    private onData(chunk: string): void {
        this.rxBuf += chunk;
        let idx: number;
        while ((idx = this.rxBuf.indexOf('\n')) !== -1) {
            const line = this.rxBuf.slice(0, idx).trim();
            this.rxBuf = this.rxBuf.slice(idx + 1);
            if (!line) {
                continue;
            }
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg.QMP) {
                this.receivedGreeting = msg;
                const greeters = this.greetingResolvers;
                this.greetingResolvers = [];
                for (const g of greeters) {
                    g(msg);
                }
                continue;
            }
            if (msg.event) {
                continue;
            }
            const next = this.pending.shift();
            if (!next) {
                continue;
            }
            if (msg.error) {
                next.reject(new Error(`QMP error: ${msg.error?.desc || JSON.stringify(msg.error)}`));
            } else {
                next.resolve(msg);
            }
        }
    }

    private onClose(): void {
        this.ready = false;
        for (const p of this.pending) {
            p.reject(new Error('QMP socket closed'));
        }
        this.pending.length = 0;
    }
}

/**
 * QEMU's HMP `xp` output looks like:
 *   00000000ffff800000040020: 0x01 0x00 0x5d 0xc0 0x01 0x00 0x00 0x00
 *   00000000ffff800000040028: 0x01 0x00 0x00 0x00 ...
 * Each line carries the address then bytes. Take the bytes in order until
 * we've collected `expected`.
 */
function parseMonitorHexDump(text: string, expected: number): Buffer {
    const out = Buffer.alloc(expected);
    let written = 0;
    for (const line of text.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) {
            continue;
        }
        const rest = line.slice(colon + 1).trim();
        if (!rest) {
            continue;
        }
        for (const tok of rest.split(/\s+/)) {
            if (!/^0x[0-9a-fA-F]+$/.test(tok)) {
                continue;
            }
            if (written >= expected) {
                return out;
            }
            out[written++] = parseInt(tok, 16) & 0xff;
        }
    }
    if (written < expected) {
        return out.slice(0, written);
    }
    return out;
}
