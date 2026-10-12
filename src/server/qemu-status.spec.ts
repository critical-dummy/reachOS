import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QEMU_AARCH64_MANIFEST,
  extractPackageNameFromLoader,
  inspectQemuAssets,
  resolveQemuAssetDirectory,
} from './qemu-status';

describe('QEMU-WASM Asset Inspector & Status Service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-status-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, {recursive: true, force: true});
    }
  });

  it('1. reports "assets_missing" when no required assets exist in directory', () => {
    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_missing');
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);
    expect(report.arch).toBe('aarch64');
    expect(report.directoryExists).toBe(true);
    expect(report.loaderCompatible).toBe(false);
    expect(report.loaderPackageName).toBeNull();
    expect(report.summary.presentRequiredCount).toBe(0);
    expect(report.summary.missingRequiredCount).toBe(report.summary.requiredCount);
    expect(report.presentFiles).toEqual([]);

    const requiredNames = QEMU_AARCH64_MANIFEST.filter((a) => a.required).map(
      (a) => a.expectedFilename
    );
    expect(report.missingRequired).toEqual(requiredNames);
    expect(report.notes).toContain('No QEMU-WASM runtime assets found');

    const dataAsset = report.assets.find((a) => a.expectedFilename === 'qemu-system-aarch64.data');
    expect(dataAsset).toBeDefined();
    expect(dataAsset?.exists).toBe(false);
    expect(dataAsset?.detectedFilename).toBeNull();
  });

  it('2. reports "assets_missing" when directory does not exist at all', () => {
    const nonExistentDir = path.join(tempDir, 'non_existent_subdir');
    const report = inspectQemuAssets(nonExistentDir);

    expect(report.status).toBe('assets_missing');
    expect(report.directoryExists).toBe(false);
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);
    expect(report.loaderCompatible).toBe(false);
    expect(report.summary.presentRequiredCount).toBe(0);
  });

  it('3. reports "assets_incomplete" when only some required assets exist', () => {
    fs.writeFileSync(
      path.join(tempDir, 'qemu-system-aarch64.js'),
      '// mock loader'
    );
    fs.writeFileSync(
      path.join(tempDir, 'qemu-system-aarch64.wasm'),
      '// mock wasm'
    );

    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_incomplete');
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);
    expect(report.presentFiles).toContain('qemu-system-aarch64.js');
    expect(report.presentFiles).toContain('qemu-system-aarch64.wasm');
    expect(report.missingRequired).toContain('qemu-system-aarch64.worker.js');
    expect(report.missingRequired).toContain('load.js');
    expect(report.missingRequired).toContain('qemu-system-aarch64.data');
    expect(report.summary.presentRequiredCount).toBe(2);
    expect(report.notes).toContain('Partial assets detected');
  });

  it('4. reports "assets_present_unverified" when all required assets exist and load.js matches qemu-system-aarch64.data', () => {
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.js'), 'binary content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.wasm'), 'binary content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.worker.js'), 'binary content');
    fs.writeFileSync(
      path.join(tempDir, 'load.js'),
      "var PACKAGE_NAME = 'qemu-system-aarch64.data';\n// Emscripten virtual fs preloader"
    );
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.data'), 'guest package payload');

    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_present_unverified');
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);
    expect(report.loaderPackageName).toBe('qemu-system-aarch64.data');
    expect(report.loaderCompatible).toBe(true);
    expect(report.missingRequired).toEqual([]);
    expect(report.summary.missingRequiredCount).toBe(0);
    expect(report.summary.presentRequiredCount).toBe(
      report.summary.requiredCount
    );

    // Truthful reporting: canonical filename detected
    expect(report.presentFiles).toContain('qemu-system-aarch64.data');
    const dataAsset = report.assets.find((a) => a.expectedFilename === 'qemu-system-aarch64.data');
    expect(dataAsset).toBeDefined();
    expect(dataAsset?.exists).toBe(true);
    expect(dataAsset?.detectedFilename).toBe('qemu-system-aarch64.data');
    expect(dataAsset?.sizeBytes).toBeGreaterThan(0);
  });

  it('5. rejects unparseable loader when data file is present: must NOT result in assets_present_unverified', () => {
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.js'), 'binary content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.wasm'), 'binary content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.worker.js'), 'binary content');
    // load.js exists, but contains arbitrary non-Emscripten code without PACKAGE_NAME
    fs.writeFileSync(
      path.join(tempDir, 'load.js'),
      'console.log("unparseable custom script without package metadata");'
    );
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.data'), 'payload');

    const report = inspectQemuAssets(tempDir);

    // Must be rejected as incomplete, NOT present_unverified!
    expect(report.status).toBe('assets_incomplete');
    expect(report.loaderPackageName).toBeNull();
    expect(report.loaderCompatible).toBe(false);
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);

    // Must accurately report that the data file physically exists on disk without fabricating absence
    const dataAsset = report.assets.find((a) => a.expectedFilename === 'qemu-system-aarch64.data');
    expect(dataAsset).toBeDefined();
    expect(dataAsset?.exists).toBe(true);
    expect(dataAsset?.detectedFilename).toBe('qemu-system-aarch64.data');

    expect(report.notes).toContain(
      "Data loader 'load.js' exists but is unparseable; required package name could not be verified"
    );
  });

  it('6. rejects mismatched loader and data bundle: must NOT result in assets_present_unverified', () => {
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.js'), 'binary content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.wasm'), 'binary content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.worker.js'), 'binary content');
    // load.js was packaged expecting 'other-bundle.data'
    fs.writeFileSync(
      path.join(tempDir, 'load.js'),
      "var PACKAGE_NAME = 'other-bundle.data';"
    );
    // But the file on disk is qemu-system-aarch64.data
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.data'), 'payload');

    const report = inspectQemuAssets(tempDir);

    // Must be rejected as incomplete!
    expect(report.status).toBe('assets_incomplete');
    expect(report.loaderPackageName).toBe('other-bundle.data');
    expect(report.loaderCompatible).toBe(false);
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);

    // Data file physically exists on disk and is reported as existing
    const dataAsset = report.assets.find((a) => a.expectedFilename === 'qemu-system-aarch64.data');
    expect(dataAsset).toBeDefined();
    expect(dataAsset?.exists).toBe(true);
    expect(dataAsset?.detectedFilename).toBe('qemu-system-aarch64.data');

    expect(report.notes).toContain(
      "Asset package mismatch: 'load.js' expects package 'other-bundle.data', but detected 'qemu-system-aarch64.data' on disk"
    );
  });

  it('7. accepts out.js as verified upstream alternative filename from examples/raspi3ap/src/htdocs', () => {
    // Upstream demo copies qemu-system-aarch64 to out.js
    fs.writeFileSync(path.join(tempDir, 'out.js'), 'upstream demo loader');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.wasm'), 'content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.worker.js'), 'content');
    fs.writeFileSync(
      path.join(tempDir, 'load.js'),
      "var PACKAGE_NAME = 'qemu-system-aarch64.data';"
    );
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.data'), 'payload');

    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_present_unverified');
    expect(report.missingRequired).toEqual([]);

    // Truthfully report detectedFilename as 'out.js', NOT 'qemu-system-aarch64.js'
    expect(report.presentFiles).toContain('out.js');
    expect(report.presentFiles).not.toContain('qemu-system-aarch64.js');

    const jsAsset = report.assets.find((a) => a.id === 'runtime-js');
    expect(jsAsset).toBeDefined();
    expect(jsAsset?.expectedFilename).toBe('qemu-system-aarch64.js');
    expect(jsAsset?.detectedFilename).toBe('out.js');
    expect(jsAsset?.exists).toBe(true);
  });

  it('8. truthfully reports missing data bundle when no data file exists', () => {
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.js'), 'content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.wasm'), 'content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.worker.js'), 'content');
    fs.writeFileSync(path.join(tempDir, 'load.js'), "var PACKAGE_NAME = 'qemu-system-aarch64.data';");

    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_incomplete');
    expect(report.loaderCompatible).toBe(false);
    expect(report.missingRequired).toContain('qemu-system-aarch64.data');

    const dataAsset = report.assets.find((a) => a.expectedFilename === 'qemu-system-aarch64.data');
    expect(dataAsset).toBeDefined();
    expect(dataAsset?.exists).toBe(false);
    expect(dataAsset?.detectedFilename).toBeNull();
  });

  it('9. extractPackageNameFromLoader accurately extracts PACKAGE_NAME and handles unparseable code', () => {
    const sample = `
      var Module = typeof Module !== 'undefined' ? Module : {};
      var PACKAGE_NAME = 'qemu-system-aarch64.data';
      var REMOTE_PACKAGE_BASE = 'qemu-system-aarch64.data';
    `;
    expect(extractPackageNameFromLoader(sample)).toBe('qemu-system-aarch64.data');
    expect(extractPackageNameFromLoader('no package name here')).toBeNull();
    expect(extractPackageNameFromLoader('')).toBeNull();
  });

  it('10. resolves asset directory robustly with explicit override and fallbacks', () => {
    const override = resolveQemuAssetDirectory(tempDir);
    expect(override).toBe(tempDir);

    const defaultDir = resolveQemuAssetDirectory();
    expect(typeof defaultDir).toBe('string');
    expect(defaultDir).toContain('qemu');
  });
});
