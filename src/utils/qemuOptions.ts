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
