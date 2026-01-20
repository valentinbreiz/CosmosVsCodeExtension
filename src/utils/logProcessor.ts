import * as vscode from 'vscode';

/**
 * Handles processing of raw command output to fix common issues like 
 * hard-wrapping at 80 columns while preserving legitimate formatting.
 */
export class LogProcessor {
    private buffer: string = '';
    private channel: vscode.OutputChannel;
    private shouldJoin: boolean;

    constructor(channel: vscode.OutputChannel, shouldJoin: boolean = false) {
        this.channel = channel;
        this.shouldJoin = shouldJoin;
    }

    /**
     * Strips ANSI escape sequences from the string.
     */
    private stripAnsi(str: string): string {
        return str.replace(/\x1b\[[0-9;]*m/g, '');
    }

    /**
     * Appends new data to the processor.
     */
    public append(data: string | Buffer) {
        this.buffer += this.stripAnsi(data.toString());
        this.processBuffer();
    }

    /**
     * Processes the current buffer and flushes complete lines to the channel.
     */
    private processBuffer() {
        while (true) {
            // Find the first newline sequence
            const match = this.buffer.match(/[\r\n]+/);
            if (!match) break;

            const index = match.index!;
            const newline = match[0];
            const nextCharIndex = index + newline.length;

            // If the newline is at the very end, wait for more data to check indentation (only if joining enabled)
            if (this.shouldJoin && nextCharIndex >= this.buffer.length) break;

            // If not joining, we can flush up to the newline immediately
            if (!this.shouldJoin) {
                this.channel.append(this.buffer.substring(0, nextCharIndex));
                this.buffer = this.buffer.substring(nextCharIndex);
                continue;
            }

            const nextChar = this.buffer[nextCharIndex];

            // Cosmos build logs heuristic: 
            // Real log lines are indented with spaces. 
            // Hard-wrapped lines (paths/commands) start at column 0 (no space).
            const isWrappedLine = nextChar !== ' ' && nextChar !== '\r' && nextChar !== '\n';

            if (isWrappedLine) {
                // Join the lines by appending everything before the newline and dropping the newline
                this.channel.append(this.buffer.substring(0, index));
                this.buffer = this.buffer.substring(nextCharIndex);
            } else {
                // Legitimate line break (or blank line). Flush up to and including the newline.
                this.channel.append(this.buffer.substring(0, nextCharIndex));
                this.buffer = this.buffer.substring(nextCharIndex);
            }
        }
    }

    /**
     * Flushes any remaining content in the buffer to the channel.
     */
    public flush() {
        if (this.buffer) {
            this.channel.append(this.buffer);
            this.buffer = '';
        }
    }
}
