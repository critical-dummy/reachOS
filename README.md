# reachOS / Fabric Dessert

> *"JUST BEHOLD! THE GREAT OPERATING SYSTEM IS FOR WEB BROWSERS!"*  
> *(Engineering Philosophy: "Think harder, Making Better.")*

**Fabric Dessert** is the virtual hardware platform and board architecture designed for **reachOS**. It provides a scalable, strongly typed virtual hardware foundation hosted in modern web environments, engineered to decouple virtual platform mechanics from browser host technologies.

---

## 🏛 Architecture Overview

The system strictly decouples the platform architecture from the host application shell:

```text
Browser / Host Environment
└── Angular Shell (src/app/)
    └── Fabric Dessert Runtime (src/fabric-dessert/)
        ├── Board / Platform (FabricDessertBoard)
        ├── Boot Substrate (BootRom & FabricDessertBootContract)
        ├── FRT64 CPU Boundary (ARM 32/64, x86 32/64, PC & Fetch boundary)
        ├── Memory Space (64-bit Physical Address Space & Sparse RAM)
        ├── Device Model & Bus (MMIO aperture router & IRQ lines)
        └── Display Subsystem
            ├── Display Controller Device (MMIO & VSYNC IRQ)
            ├── Framebuffer (1080 × 2424 RGBA8888 pixel buffer)
            ├── System Renderer (Platform-side presentation coordinator)
            ├── Canvas Backend (Deterministic 1:1 host adapter)
            └── Default Console Font (font_sun_8x16)
```

---

## ⚡ Reset Sequence & Boot Topology

The platform executes a deterministic hardware reset sequence following board boot topology:

```text
Power / Reset
    ↓
Board reset (device bus reset & reset vector propagation)
    ↓
FRT64 CPU topology partition:
  ├── Primary Boot CPU → RESET state, PC set to configured Fabric Dessert reset vector
  └── Secondary CPUs  → PARKED state (held until future OS SMP bring-up)
    ↓
CPU instruction-fetch boundary accesses Boot ROM via Physical Address Space
  (enforces execute permissions, neutral requested byte lengths, no fake ISA decoding)
```

> **Platform Contract Note**: Boot ROM at `0x00000000` and reset vector at `0x00000000` are strictly a **Fabric Dessert board/platform contract**, not an ISA-specific or Linux-specific boot specification.

---

## 🧩 Subsystem Details

### 1. Board & Platform (`src/fabric-dessert/board/`)
* **`FabricDessertBoard`**: The central interconnect tying CPU boundaries, physical memory spaces, Boot ROM, and device busses.
* Fully dynamic hardware topology—CPU core counts, RAM sizes, Boot ROM location/size, and MMIO address windows are configurable and not locked to artificial small-machine constraints.
* **`BootRom` & `FabricDessertBootContract`**: Read-only physical memory region with explicit reset vector mapping, boundary protection, and initial payload support.

### 2. CPU Integration Boundary (`src/fabric-dessert/arch/frt64/`)
* **FRT64 MultiSupport Architecture**: External CPU architecture boundary integrating:
  * **ARM 32-bit**
  * **ARM 64-bit**
  * **x86 32-bit**
  * **x86 64-bit**
* Provides hardware execution contracts, bus master attachments, core topology management, and interrupt line hooks without simulation shortcuts.

### 3. Configurable Memory Space (`src/fabric-dessert/memory/`)
* **64-bit Address Space (`PhysicalAddressSpace`)**: Full `bigint`-backed 64-bit physical memory addressing.
* **Sparse Physical Backing (`SparsePhysicalMemoryRegion`)**: 64 KiB chunked allocation preventing premature heap exhaustion while supporting gigabyte-scale RAM layouts.
* Conflict-free region mapping, access boundary checks, and MMIO range dispatching.

### 4. Device Model & Device Bus (`src/fabric-dessert/device/`)
* **`DeviceBus`**: Manages MMIO aperture allocations, alignment requirements, IRQ vector assignments, and device enumeration.
* **`IDevice` & `IDeviceContext`**: Clean hardware component abstraction across controllers, timers, display units, and custom peripherals.

### 5. Display Subsystem (`src/fabric-dessert/display/`)
A deterministic, unscaled display pipeline:
1. **Display Device (`FabricDessertDisplayDevice`)**: Exposes control registers (`0x53494446` magic, dimensions, commands) and direct framebuffer memory aperture over MMIO.
2. **Framebuffer (`Framebuffer`)**: Physical pixel storage at **1080 × 2424 × 4 bytes (RGBA8888)** with deterministic 1:1 coordinate mapping.
3. **System Renderer (`SystemRenderer`)**: Platform-side renderer with zero DOM or browser dependencies.
4. **Canvas Backend (`CanvasBackend`)**: Host-side adapter blitting pixel buffers directly into the 1080 × 2424 Canvas without interpolation or layout-driven scaling.
5. **Default Console Font (`font_sun_8x16`)**: Standard 8×16 bitmap font (`fontdata_sun8x16`, 256 glyphs, 4096 bytes from the Linux kernel console specification) established as the default font for the bootloader and kernel console.

---

## 📁 Repository Structure

```text
├── src/
│   ├── app/                      # Angular host shell (Host integration only)
│   │   ├── app.html              # Fixed 1080 × 2424 output canvas
│   │   ├── app.ts                # Host startup & display attachment
│   │   └── fabric-dessert-host.ts# Angular-to-runtime bridge
│   ├── fabric-dessert/           # Core platform domain (Zero DOM/Angular deps)
│   │   ├── arch/frt64/           # FRT64 CPU boundary & topology
│   │   ├── board/                # Board definition & configuration
│   │   ├── device/               # Device bus, MMIO router, registry
│   │   ├── display/              # Display device, framebuffer & renderer
│   │   ├── memory/               # 64-bit address space & sparse memory
│   │   ├── runtime/              # Lifecycle state machine & instance factory
│   │   └── index.ts              # Clean platform export boundary
│   ├── index.html                # Host HTML shell
│   └── main.ts                   # Angular entry point
├── metadata.json
└── package.json
```

---

## 🚀 Getting Started

### Prerequisites
* Node.js 20+
* npm

### Installation
```bash
npm install
```

### Development Server
```bash
npm run dev
```
Starts the development server on `http://localhost:3000`.

### Running Tests
```bash
npm test -- --watch=false
```
Executes comprehensive Vitest test suites covering memory space, device buses, CPU boundaries, lifecycle states, and display subsystem determinism.

### Building for Production
```bash
npm run build
```

### Code Quality & Linting
```bash
npm run lint
```
