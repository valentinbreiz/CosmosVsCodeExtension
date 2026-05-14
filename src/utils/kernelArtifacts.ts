import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves the kernel ELF on disk. Cosmos.Sdk routes outputs to a repo-level
 * artifacts directory (`<workspace>/artifacts/bin/<proj>/debug_linux-<arch>/`),
 * but a few older project layouts still drop the binary under
 * `<projectDir>/bin/Debug/net10.0/linux-<arch>/`. Try the modern path first,
 * fall back to the legacy one. Returns undefined when no ELF is found.
 */
export function resolveKernelElf(
    workspaceFolder: string,
    projectDir: string,
    projectName: string,
    arch: string
): string | undefined {
    const candidates = [
        // Modern: Cosmos.Sdk-routed artifacts directory.
        path.join(workspaceFolder, 'artifacts', 'bin', projectName, `debug_linux-${arch}`),
        // Legacy: plain dotnet output under the project.
        path.join(projectDir, 'bin', 'Debug', 'net10.0', `linux-${arch}`)
    ];

    for (const dir of candidates) {
        if (!fs.existsSync(dir)) {
            continue;
        }
        // Prefer "<projectName>.elf" if it exists, otherwise the first ELF.
        const named = path.join(dir, `${projectName}.elf`);
        if (fs.existsSync(named)) {
            return named;
        }
        try {
            const elfs = fs.readdirSync(dir).filter(f => f.endsWith('.elf'));
            if (elfs.length > 0) {
                return path.join(dir, elfs[0]);
            }
        } catch {
            // ignore directory read errors and keep trying alternatives
        }
    }

    return undefined;
}
