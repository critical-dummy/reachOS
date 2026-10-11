# QEMU-WASM Runtime Asset Acquisition Guide

This document describes the runtime asset requirements, expected directory layout, and compilation procedure for running QEMU-WASM AArch64 in reachOS.

reachOS **does not vendor precompiled binaries** or fake runtime files. All WebAssembly and guest OS assets must be built from traceable, licensed upstream sources and placed into the designated static asset directory.

---

## 1. Expected Directory & File Layout

Place all runtime and guest assets in the static assets directory:

```
public/qemu/
├── qemu-system-aarch64.js          # Required: Emscripten runtime loader
├── qemu-system-aarch64.wasm        # Required: Compiled QEMU AArch64 Wasm binary
├── qemu-system-aarch64.worker.js   # Required: Emscripten pthread Web Worker script
├── load.js                         # Required: Preloaded filesystem loader script
└── load.data                       # Required: Packaged kernel, DTB, and initramfs bundle
                                    # (or named: qemu-system-aarch64.data)
```

> **Note:** During the Angular build process, files placed in `public/` are automatically copied to the browser distribution root (`dist/app/browser/qemu/`). The server endpoint checks both locations.

---

## 2. Building Upstream Artifacts

Upstream project: [https://github.com/ktock/qemu-wasm](https://github.com/ktock/qemu-wasm)

### Prerequisites
* Linux host (x86_64 or aarch64) with Docker installed.
* Git.

### Step-by-Step Build Procedure

1. **Clone the upstream repository:**
   ```bash
   git clone https://github.com/ktock/qemu-wasm.git
   cd qemu-wasm
   ```

2. **Launch the Docker build container (Emscripten SDK):**
   ```bash
   # Build the container environment with Emscripten and pre-compiled libraries (GLib, Pixman, zlib)
   docker build -t build-qemu-wasm .
   docker run -it --rm -v $(pwd):/workspace -w /workspace build-qemu-wasm bash
   ```

3. **Configure and build `qemu-system-aarch64`:**
   Inside the build container:
   ```bash
   mkdir -p build && cd build
   emconfigure ../configure \
     --target-list=aarch64-softmmu \
     --static \
     --disable-tools \
     --disable-guest-agent \
     --extra-cflags="-O3 -matomics -mbulk-memory -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sALLOW_TABLE_GROWTH=1 -sWASM_BIGINT=1 -sTOTAL_MEMORY=2048MB"
   emmake make -j$(nproc)
   ```
   This generates:
   * `qemu-system-aarch64.js`
   * `qemu-system-aarch64.wasm`
   * `qemu-system-aarch64.worker.js`

4. **Prepare and package guest OS images (e.g. Raspberry Pi 3 A+ example):**
   Upstream provides a pre-packaged build recipe in `examples/raspi3ap/image/`:
   ```bash
   cd ../examples/raspi3ap/image
   docker build -t build-raspi3ap-image .
   docker run --rm -v $(pwd):/out build-raspi3ap-image
   ```
   Package the kernel, DTB, and BusyBox initramfs into Emscripten virtual filesystem files using `file_packager.py`:
   ```bash
   python3 $EMSDK/upstream/emscripten/tools/file_packager.py \
     load.data \
     --preload zImage@/zImage bcm2837-rpi-3-a-plus.dtb@/bcm2837-rpi-3-a-plus.dtb rootfs.cpio@/rootfs.cpio \
     --js-output=load.js
   ```
   This generates:
   * `load.js`
   * `load.data`

---

## 3. Deployment into reachOS

Copy the generated outputs into the reachOS workspace:

```bash
mkdir -p public/qemu
cp qemu-system-aarch64.js public/qemu/
cp qemu-system-aarch64.wasm public/qemu/
cp qemu-system-aarch64.worker.js public/qemu/
cp load.js public/qemu/
cp load.data public/qemu/
```

---

## 4. Verifying Asset Presence via Status API

After copying the files, query the server endpoint:

```bash
curl -s http://localhost:3000/api/qemu/status
```

Expected response transitions:
* **`assets_missing`**: No required files found in `public/qemu/`.
* **`assets_incomplete`**: Some files present, but missing others (the response lists `missingRequired`).
* **`assets_present_unverified`**: All required files are present on disk. Note that `bootVerified` remains `false` until client-side execution is implemented and verified.

---

## 5. Licensing & Compliance

* **QEMU:** Licensed under GPLv2 and LGPLv2.1.
* **Linux Kernel:** Licensed under GPLv2.
* **BusyBox:** Licensed under GPLv2.
* When distributing or hosting binary artifacts, you must comply with their respective open-source licenses and provide source code or written offers as required by the GPL.
