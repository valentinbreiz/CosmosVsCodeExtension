/**
 * Per-suite default timeouts in seconds. Mirrors the historical
 * .vscode/launch.json entries; ARM64 boots and runs ~1.5x slower than x64
 * under TCG so timeouts are scaled accordingly.
 */
const X64_DEFAULTS: Record<string, number> = {
    HelloWorld: 60,
    TypeCasting: 60,
    Memory: 60,
    Storage: 90,
    Timer: 120,
    Network: 120,
    Runtime: 120,
    Threading: 120,
    Graphic: 120,
    GarbageCollector: 120,
    Power: 180,
    Math: 60
};

const ARM64_DEFAULTS: Record<string, number> = {
    HelloWorld: 90,
    TypeCasting: 90,
    Memory: 90,
    Storage: 180,
    Timer: 180,
    Network: 180,
    Runtime: 180,
    Threading: 180,
    Graphic: 180,
    GarbageCollector: 180,
    Power: 270,
    Math: 90
};

export function defaultTimeoutSeconds(suiteName: string, arch: string): number {
    const table = arch === 'arm64' ? ARM64_DEFAULTS : X64_DEFAULTS;
    const direct = table[suiteName];
    if (direct !== undefined) {
        return direct;
    }
    return arch === 'arm64' ? 180 : 120;
}
