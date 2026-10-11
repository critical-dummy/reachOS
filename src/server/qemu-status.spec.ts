import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QEMU_AARCH64_MANIFEST,
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
    expect(report.summary.presentRequiredCount).toBe(0);
  });

  it('3. reports "assets_incomplete" when only some required assets exist', () => {
    // Create only qemu-system-aarch64.js and load.js
    fs.writeFileSync(
      path.join(tempDir, 'qemu-system-aarch64.js'),
      '// mock loader'
    );
    fs.writeFileSync(path.join(tempDir, 'load.js'), '// mock fs loader');

    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_incomplete');
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);
    expect(report.presentFiles).toContain('qemu-system-aarch64.js');
    expect(report.presentFiles).toContain('load.js');
    expect(report.missingRequired).toContain('qemu-system-aarch64.wasm');
    expect(report.missingRequired).toContain('qemu-system-aarch64.worker.js');
    expect(report.missingRequired).toContain('qemu-system-aarch64.data');
    expect(report.summary.presentRequiredCount).toBe(2);
    expect(report.notes).toContain('Partial assets detected');
  });

  it('4. reports "assets_present_unverified" with canonical data-bundle filename (qemu-system-aarch64.data)', () => {
    // Create all required manifest files using canonical names
    for (const spec of QEMU_AARCH64_MANIFEST) {
      if (spec.required) {
        fs.writeFileSync(path.join(tempDir, spec.expectedFilename), 'binary content');
      }
    }

    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_present_unverified');
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);
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

  it('5. accepts and truthfully reports verified upstream alternative filename (load.data) without fabricating canonical name', () => {
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.js'), 'content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.wasm'), 'content');
    fs.writeFileSync(
      path.join(tempDir, 'qemu-system-aarch64.worker.js'),
      'content'
    );
    fs.writeFileSync(path.join(tempDir, 'load.js'), 'content');
    // Supply alternative data filename instead of qemu-system-aarch64.data
    fs.writeFileSync(path.join(tempDir, 'load.data'), 'alternative-bundle');

    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_present_unverified');
    expect(report.bootVerified).toBe(false);
    expect(report.executionReady).toBe(false);
    expect(report.missingRequired).toEqual([]);

    // Crucial requirement: presentFiles must contain the filename actually found ('load.data'),
    // and must NOT claim that 'qemu-system-aarch64.data' exists!
    expect(report.presentFiles).toContain('load.data');
    expect(report.presentFiles).not.toContain('qemu-system-aarch64.data');

    const dataAsset = report.assets.find((a) => a.expectedFilename === 'qemu-system-aarch64.data');
    expect(dataAsset).toBeDefined();
    expect(dataAsset?.exists).toBe(true);
    expect(dataAsset?.expectedFilename).toBe('qemu-system-aarch64.data');
    expect(dataAsset?.detectedFilename).toBe('load.data');
  });

  it('6. truthfully reports missing data bundle when neither canonical nor alternative filename exists', () => {
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.js'), 'content');
    fs.writeFileSync(path.join(tempDir, 'qemu-system-aarch64.wasm'), 'content');
    fs.writeFileSync(
      path.join(tempDir, 'qemu-system-aarch64.worker.js'),
      'content'
    );
    fs.writeFileSync(path.join(tempDir, 'load.js'), 'content');
    // Neither qemu-system-aarch64.data nor load.data created

    const report = inspectQemuAssets(tempDir);

    expect(report.status).toBe('assets_incomplete');
    expect(report.missingRequired).toContain('qemu-system-aarch64.data');

    const dataAsset = report.assets.find((a) => a.expectedFilename === 'qemu-system-aarch64.data');
    expect(dataAsset).toBeDefined();
    expect(dataAsset?.exists).toBe(false);
    expect(dataAsset?.detectedFilename).toBeNull();
  });

  it('7. resolves asset directory robustly with explicit override and fallbacks', () => {
    const override = resolveQemuAssetDirectory(tempDir);
    expect(override).toBe(tempDir);

    const defaultDir = resolveQemuAssetDirectory();
    expect(typeof defaultDir).toBe('string');
    expect(defaultDir).toContain('qemu');
  });
});
