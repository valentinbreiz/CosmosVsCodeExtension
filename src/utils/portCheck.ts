import * as net from 'net';

/**
 * Returns true if something is listening on `port` on the loopback interface.
 * We open a client socket and treat a successful connect as "busy"; ECONNREFUSED
 * (no listener) means the port is free.
 */
export function isPortInUse(port: number, host: string = '127.0.0.1'): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const socket = new net.Socket();
        const finish = (busy: boolean) => {
            socket.destroy();
            resolve(busy);
        };
        socket.setTimeout(500);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, host);
    });
}
