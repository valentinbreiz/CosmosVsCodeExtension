import * as fs from 'fs';
import * as path from 'path';
import { DiskConfig } from './project';

// Parse memory strings like "512", "512M", "1G" into MB.
// Used by run/debug to translate the project's qemu.memory string into the
// integer MB that `cosmos run -m` expects.
export function parseMemoryMb(s: string): number | null {
    const m = s.match(/^(\d+)\s*([MmGg]?)/);
    if (!m) {
        return null;
    }
    let n = parseInt(m[1], 10);
    if (m[2] === 'G' || m[2] === 'g') {
        n *= 1024;
    }
    return n;
}

// Parse size strings like "256", "256M", "1G", "512K" into bytes. A bare
// number, or the M suffix, means mebibytes — matching how disk sizes are
// usually written (and the Makefile's `truncate -s 256M`).
export function parseSizeBytes(s: string): number | null {
    const m = s.trim().match(/^(\d+)\s*([KkMmGg]?)/);
    if (!m) {
        return null;
    }
    let n = parseInt(m[1], 10);
    const unit = m[2].toUpperCase();
    if (unit === 'G') {
        n *= 1024 * 1024 * 1024;
    } else if (unit === 'K') {
        n *= 1024;
    } else {
        n *= 1024 * 1024; // '' or 'M' → MiB
    }
    return n;
}

// Build the `cosmos run --cpu <model>` argument from the configured CPU model
// (properties page: Max / QEMU64 / Host on x64). An empty/absent value yields
// no args, letting the launcher pick its default (host under KVM, max under
// TCG on x64; cortex-a72 on arm64).
export function buildCpuArgs(cpuModel: string | undefined): string[] {
    if (!cpuModel || !cpuModel.trim()) {
        return [];
    }
    return ['--cpu', cpuModel.trim()];
}

// Build the `cosmos run --nic <model>` argument from the configured card.
// 'none' is passed through explicitly so QEMU's default NIC is disabled — the
// whole point of the selector. An empty/absent value yields no args, leaving
// QEMU's default in place.
export function buildNicArgs(networkCard: string | undefined): string[] {
    if (!networkCard || !networkCard.trim()) {
        return [];
    }
    return ['--nic', networkCard.trim()];
}

// Build `cosmos run --hostfwd <rule>` args, one per configured port forward
// (e.g. tcp::2323-:23). The launcher validates each rule and puts it on the
// network card's user-mode backend; with no card it refuses them.
export function buildHostForwardArgs(portForwards: string[] | undefined): string[] {
    const args: string[] = [];
    for (const rule of portForwards ?? []) {
        if (rule.trim()) {
            args.push('--hostfwd', rule.trim());
        }
    }
    return args;
}

// Split the free-form Extra Arguments field into the argv entries that follow
// `cosmos run --`: whitespace separates arguments, except inside double
// quotes. The quotes stay in the entry, since cosmos run joins the entries
// back into QEMU's command line, where they still group the quoted text into
// one argument (e.g. -name "my vm" or file="a b.img").
export function splitExtraArgs(extraArgs: string | undefined): string[] {
    return (extraArgs ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

// Build `cosmos run --keyboard/--mouse <model>` args from the configured input
// devices. Values are passed through as-is; the launcher treats 'ps2'/'none' as
// "add nothing" (x64 PS/2 is built into the chipset) and attaches only real
// device models like virtio-keyboard-device (needed on the arm64 virt machine).
export function buildInputArgs(keyboard: string | undefined, mouse: string | undefined): string[] {
    const args: string[] = [];
    if (keyboard && keyboard.trim()) {
        args.push('--keyboard', keyboard.trim());
    }
    if (mouse && mouse.trim()) {
        args.push('--mouse', mouse.trim());
    }
    return args;
}

// Build the `cosmos run --audio <model>` argument from the configured sound
// card. 'none' is the default and yields no args, so a project without audio
// launches exactly the command it did before the selector existed; any other
// value names a QEMU HD Audio controller for the launcher to attach, codec
// included.
export function buildAudioArgs(audio: string | undefined): string[] {
    if (!audio || !audio.trim() || audio.trim() === 'none') {
        return [];
    }
    return ['--audio', audio.trim()];
}

// Turn the project's configured disks into `cosmos run --disk <path>,<kind>`
// arguments, creating any image that doesn't exist yet as a sparse file of the
// requested size. Paths are resolved against the project directory; existing
// images are never resized. Rows without a path are skipped. Throws on a bad
// size or a failed file creation so the caller can surface it.
export function prepareDiskArgs(
    projectDir: string,
    disks: DiskConfig[] | undefined,
    log?: (message: string) => void
): string[] {
    const args: string[] = [];
    if (!disks) {
        return args;
    }

    for (const disk of disks) {
        if (!disk.path || !disk.path.trim()) {
            continue;
        }
        const kind = disk.type === 'nvme' ? 'nvme' : 'ahci';
        const absPath = path.isAbsolute(disk.path)
            ? disk.path
            : path.join(projectDir, disk.path);

        if (!fs.existsSync(absPath)) {
            const sizeStr = disk.size && disk.size.trim() ? disk.size : '256M';
            const bytes = parseSizeBytes(sizeStr);
            if (bytes === null || bytes <= 0) {
                throw new Error(`Invalid disk size "${sizeStr}" for ${disk.path}`);
            }
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            const fd = fs.openSync(absPath, 'w');
            try {
                fs.ftruncateSync(fd, bytes);
            } finally {
                fs.closeSync(fd);
            }
            log?.(`Created disk image ${absPath} (${sizeStr})`);
        }

        args.push('--disk', `${absPath},${kind}`);
    }

    return args;
}
