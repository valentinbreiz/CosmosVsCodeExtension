# Cosmos OS Development for VS Code

VS Code extension for building bare-metal OS kernels with **Cosmos gen3** — the
[NativeAOT-based](https://valentinbreiz.github.io/nativeaot-patcher/) rewrite of Cosmos
that compiles C# to a bootable UEFI kernel with the .NET ILC compiler and the Cosmos IL
patcher (no more IL2CPU).

Create a kernel project, build it to a bootable image, run it in QEMU and debug it with
GDB — all from the editor.

## Features

- **Create Kernel Project** — scaffold a new gen3 kernel from the `cosmos new` template through a guided wizard.
- **Build / Run / Debug** — build the kernel, run it in QEMU, or attach the GDB debugger, from the Command Palette or the Cosmos sidebar.
- **Tool management** — detect missing tools (.NET 10 SDK, Cosmos CLI, QEMU, GDB) and install them with one click via `cosmos install`.
- **Project Properties** — edit the kernel's build and QEMU configuration.
- **Live kernel diagnostics** — inspect kernel threads, garbage collector state, and memory from dedicated panels while debugging.
- **Clean** — remove build outputs.

## Requirements

- [.NET SDK 10.0](https://dotnet.microsoft.com/download) or later
- [Cosmos.Tools](https://www.nuget.org/packages/Cosmos.Tools) CLI (`cosmos`)
- QEMU — for running and debugging
- GDB (`gdb` for x64, `gdb-multiarch` for ARM64) — for debugging
- The **C/C++** extension (`ms-vscode.cpptools`) — provides the `cppdbg` debug adapter

The extension prompts to install any missing tools automatically.

## Installation

Install the extension from the Marketplace, then set up the toolchain:

**Linux / macOS**

```bash
dotnet tool install -g Cosmos.Tools
cosmos install   # installs QEMU, GDB, the patcher, project templates and this extension
cosmos check     # verify the toolchain
```

**Windows**

Download and run `CosmosSetup-<version>-windows.exe` from the
[Releases](https://github.com/valentinbreiz/nativeaot-patcher/releases) page, then verify with `cosmos check`.

To update the toolchain later, run `cosmos update` (add `--check` to preview,
`--no-project` to leave project files untouched).

## Getting Started

1. Open the Command Palette and run **Cosmos: Create Kernel Project** (or click the Cosmos icon in the Activity Bar).
2. Follow the wizard to scaffold your kernel.
3. Write your kernel by overriding the `BeforeRun` / `Run` / `AfterRun` lifecycle:

   ```csharp
   using System;
   using Sys = Cosmos.Kernel.System;

   namespace MyOS;

   public class Kernel : Sys.Kernel
   {
       protected override void BeforeRun() => Console.WriteLine("Cosmos booted successfully!");
       protected override void Run() => Console.WriteLine("Hello from gen3!");
   }
   ```

4. Run **Cosmos: Build Kernel**, then **Cosmos: Run in QEMU**.
5. To debug, set breakpoints and pick **Debug x64 Kernel** (or **Debug ARM64 Kernel**) in the Run and Debug view — QEMU starts frozen with a GDB server and the debugger attaches.

## Documentation

Full user guide for building Cosmos gen3 kernels:

- [Installation Guide](https://valentinbreiz.github.io/nativeaot-patcher/articles/user/install.html)
- [Kernel Startup](https://valentinbreiz.github.io/nativeaot-patcher/articles/user/startup.html) — the boot chain and the `BeforeRun`/`Run`/`AfterRun` lifecycle
- [File System](https://valentinbreiz.github.io/nativeaot-patcher/articles/user/filesystem.html)
- [Network](https://valentinbreiz.github.io/nativeaot-patcher/articles/user/network.html)
- [Graphics](https://valentinbreiz.github.io/nativeaot-patcher/articles/user/graphics.html)
- [Debugging with VS Code and QEMU](https://valentinbreiz.github.io/nativeaot-patcher/articles/user/debugging.html)

## License

MIT
