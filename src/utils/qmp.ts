import * as net from 'net';
import * as fs from 'fs';

/**
 * QEMU Machine Protocol (QMP) client for reading guest memory without pausing.
 */
export class QMPClient {
    private socket: net.Socket | null = null;
    private connected: boolean = false;
    private responseBuffer: string = '';
    private pendingRequests: Map<number, { resolve: (data: any) => void, reject: (error: Error) => void }> = new Map();
    private nextId: number = 1;

    constructor(private socketPath: string) {}

    /**
     * Connect to QEMU QMP socket.
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = net.createConnection(this.socketPath);

            this.socket.on('connect', () => {
                console.log('[QMP] Connected to QEMU');
            });

            this.socket.on('data', (data) => {
                this.responseBuffer += data.toString();
                this.processResponses();
            });

            this.socket.on('error', (err) => {
                console.error('[QMP] Socket error:', err);
                reject(err);
            });

            this.socket.on('close', () => {
                console.log('[QMP] Connection closed');
                this.connected = false;
            });

            // Wait for QMP greeting
            const onData = (data: Buffer) => {
                const greeting = data.toString();
                if (greeting.includes('QMP')) {
                    console.log('[QMP] Received greeting');
                    this.socket?.off('data', onData);

                    // Send qmp_capabilities to complete handshake
                    this.sendCommand('qmp_capabilities', {}).then(() => {
                        this.connected = true;
                        resolve();
                    }).catch(reject);
                }
            };

            this.socket.on('data', onData);

            setTimeout(() => reject(new Error('QMP connection timeout')), 5000);
        });
    }

    /**
     * Process buffered QMP responses.
     */
    private processResponses(): void {
        const lines = this.responseBuffer.split('\n');
        this.responseBuffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const response = JSON.parse(line);

                if (response.return !== undefined && response.id !== undefined) {
                    const pending = this.pendingRequests.get(response.id);
                    if (pending) {
                        pending.resolve(response.return);
                        this.pendingRequests.delete(response.id);
                    }
                } else if (response.error && response.id !== undefined) {
                    const pending = this.pendingRequests.get(response.id);
                    if (pending) {
                        pending.reject(new Error(response.error.desc || 'QMP error'));
                        this.pendingRequests.delete(response.id);
                    }
                }
            } catch (err) {
                console.error('[QMP] Failed to parse response:', line);
            }
        }
    }

    /**
     * Send a QMP command.
     */
    private async sendCommand(command: string, args: any): Promise<any> {
        if (!this.socket) {
            throw new Error('QMP not connected');
        }

        const id = this.nextId++;
        const request = JSON.stringify({ execute: command, arguments: args, id }) + '\n';

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.socket!.write(request);

            // Timeout after 10 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('QMP command timeout'));
                }
            }, 10000);
        });
    }

    /**
     * Read guest physical memory.
     * Returns a Buffer with the memory contents.
     */
    async readMemory(address: bigint, size: number): Promise<Buffer> {
        // Use human-monitor-command to read memory
        // Format: x/NNNxb <address> where NNN is the byte count
        const cmd = `x/${size}xb 0x${address.toString(16)}`;
        const result = await this.sendCommand('human-monitor-command', { 'command-line': cmd });

        // Parse the hex dump output
        // Format: 0xADDRESS: 0xXX 0xXX 0xXX ...
        return this.parseHexDump(result, size);
    }

    /**
     * Parse hex dump output from QEMU monitor.
     */
    private parseHexDump(output: string, expectedSize: number): Buffer {
        const bytes: number[] = [];

        // Match hex values in the format 0xXX
        const hexPattern = /0x([0-9a-fA-F]{2})/g;
        let match;

        while ((match = hexPattern.exec(output)) !== null) {
            bytes.push(parseInt(match[1], 16));
        }

        if (bytes.length < expectedSize) {
            console.warn(`[QMP] Expected ${expectedSize} bytes but got ${bytes.length}`);
        }

        return Buffer.from(bytes.slice(0, expectedSize));
    }

    /**
     * Get the address of a symbol via monitor command.
     */
    async getSymbolAddress(symbol: string): Promise<bigint | null> {
        try {
            const result = await this.sendCommand('human-monitor-command', {
                'command-line': `info symbol ${symbol}`
            });

            // Try to extract address from result
            const addrMatch = result.match(/0x[0-9a-fA-F]+/);
            if (addrMatch) {
                return BigInt(addrMatch[0]);
            }
        } catch (err) {
            console.warn('[QMP] Could not get symbol address:', err);
        }
        return null;
    }

    /**
     * Close the QMP connection.
     */
    disconnect(): void {
        if (this.socket) {
            this.socket.end();
            this.socket = null;
            this.connected = false;
        }
    }

    isConnected(): boolean {
        return this.connected;
    }
}
