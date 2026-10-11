import {TestBed} from '@angular/core/testing';
import {
  detectBrowserRuntimeCapabilities,
} from './runtime-capabilities';
import {
  QemuServerStatusResponse,
  QemuStatusClient,
} from './qemu-status-client';

describe('Phase 2: Browser Runtime Capability Detection', () => {
  it('1. detects all required browser capabilities when available in fully isolated context', () => {
    const mockWindow = {
      isSecureContext: true,
      WebAssembly: {
        validate: () => true,
      },
      SharedArrayBuffer: class {},
      crossOriginIsolated: true,
      Worker: class {},
    } as unknown as Window;

    const caps = detectBrowserRuntimeCapabilities(mockWindow);

    expect(caps.isBrowser).toBe(true);
    expect(caps.isSecureContext).toBe(true);
    expect(caps.hasWebAssembly).toBe(true);
    expect(caps.hasWasmValidate).toBe(true);
    expect(caps.hasSharedArrayBuffer).toBe(true);
    expect(caps.isCrossOriginIsolated).toBe(true);
    expect(caps.hasWebWorker).toBe(true);
    expect(caps.basicWasmSupported).toBe(true);
    expect(caps.multithreadedWasmSupported).toBe(true);
    expect(caps.limitations).toEqual([]);
    expect(caps.recommendedAction).toBeNull();
  });

  it('2. detects when SharedArrayBuffer is unavailable and flags multithreaded limitation', () => {
    const mockWindow = {
      isSecureContext: true,
      WebAssembly: {
        validate: () => true,
      },
      // SharedArrayBuffer is undefined
      crossOriginIsolated: true,
      Worker: class {},
    } as unknown as Window;

    const caps = detectBrowserRuntimeCapabilities(mockWindow);

    expect(caps.hasSharedArrayBuffer).toBe(false);
    expect(caps.basicWasmSupported).toBe(true);
    expect(caps.multithreadedWasmSupported).toBe(false);
    expect(caps.limitations.some((l) => l.includes('SharedArrayBuffer'))).toBe(true);
    expect(caps.recommendedAction).not.toBeNull();
    expect(caps.recommendedAction).toContain('standalone browser tab');
    // Ensure it does NOT promise standalone tab always works
    expect(caps.recommendedAction).toContain('will not guarantee isolation');
  });

  it('3. detects when crossOriginIsolated is false (e.g. inside unprivileged iframe)', () => {
    const mockWindow = {
      isSecureContext: true,
      WebAssembly: {
        validate: () => true,
      },
      SharedArrayBuffer: class {},
      crossOriginIsolated: false, // iframe constraint
      Worker: class {},
    } as unknown as Window;

    const caps = detectBrowserRuntimeCapabilities(mockWindow);

    expect(caps.isCrossOriginIsolated).toBe(false);
    expect(caps.basicWasmSupported).toBe(true);
    expect(caps.multithreadedWasmSupported).toBe(false);
    expect(caps.limitations.some((l) => l.includes('crossOriginIsolated is false'))).toBe(true);
    expect(caps.recommendedAction).toContain('embedded preview iframe');
  });

  it('4. detects when WebAssembly is unavailable', () => {
    const mockWindow = {
      isSecureContext: true,
      WebAssembly: undefined,
      SharedArrayBuffer: class {},
      crossOriginIsolated: true,
      Worker: class {},
    } as unknown as Window;

    const caps = detectBrowserRuntimeCapabilities(mockWindow);

    expect(caps.hasWebAssembly).toBe(false);
    expect(caps.hasWasmValidate).toBe(false);
    expect(caps.basicWasmSupported).toBe(false);
    expect(caps.multithreadedWasmSupported).toBe(false);
    expect(caps.limitations.some((l) => l.includes('WebAssembly API is unavailable'))).toBe(true);
  });

  it('5. detects when Web Worker is unavailable', () => {
    const mockWindow = {
      isSecureContext: true,
      WebAssembly: {
        validate: () => true,
      },
      SharedArrayBuffer: class {},
      crossOriginIsolated: true,
      Worker: undefined,
    } as unknown as Window;

    const caps = detectBrowserRuntimeCapabilities(mockWindow);

    expect(caps.hasWebWorker).toBe(false);
    expect(caps.basicWasmSupported).toBe(true);
    expect(caps.multithreadedWasmSupported).toBe(false);
    expect(caps.limitations.some((l) => l.includes('Web Worker API is unavailable'))).toBe(true);
  });

  it('6. safely handles server-side rendering or non-browser execution (null window)', () => {
    const caps = detectBrowserRuntimeCapabilities(null);

    expect(caps.isBrowser).toBe(false);
    expect(caps.hasWebAssembly).toBe(false);
    expect(caps.hasSharedArrayBuffer).toBe(false);
    expect(caps.isCrossOriginIsolated).toBe(false);
    expect(caps.multithreadedWasmSupported).toBe(false);
    expect(caps.limitations.some((l) => l.includes('Non-browser'))).toBe(true);
    expect(caps.recommendedAction).toBeNull();
  });

  describe('QemuStatusClient service', () => {
    let client: QemuStatusClient;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [QemuStatusClient],
      });
      client = TestBed.inject(QemuStatusClient);
    });

    it('7. handles Status API network failure gracefully without throwing', async () => {
      const failingFetch = (async () => {
        throw new Error('Network connection refused');
      }) as unknown as typeof fetch;

      await client.fetchServerStatus(failingFetch);

      expect(client.serverStatus()).toBeNull();
      expect(client.serverError()).toContain('Network connection refused');
      expect(client.isLoading()).toBe(false);
      // Execution readiness and Linux boot must remain strictly false
      expect(client.bootVerified()).toBe(false);
      expect(client.executionReady()).toBe(false);
    });

    it('8. handles Status API non-200 HTTP error gracefully', async () => {
      const httpErrorFetch = (async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      })) as unknown as typeof fetch;

      await client.fetchServerStatus(httpErrorFetch);

      expect(client.serverStatus()).toBeNull();
      expect(client.serverError()).toContain('503 Service Unavailable');
      expect(client.bootVerified()).toBe(false);
      expect(client.executionReady()).toBe(false);
    });

    it('9. parses successful Status API response while keeping executionReady and bootVerified false', async () => {
      const mockResponse: QemuServerStatusResponse = {
        status: 'assets_missing',
        bootVerified: false,
        executionReady: false,
        arch: 'aarch64',
        assetDirectory: '/public/qemu',
        directoryExists: false,
        summary: {
          requiredCount: 5,
          presentRequiredCount: 0,
          missingRequiredCount: 5,
          totalCheckedCount: 5,
        },
        missingRequired: ['qemu-system-aarch64.wasm'],
        presentFiles: [],
        assets: [],
        notes: 'Assets missing.',
      };

      const successfulFetch = (async () => ({
        ok: true,
        json: async () => mockResponse,
      })) as unknown as typeof fetch;

      await client.fetchServerStatus(successfulFetch);

      expect(client.serverError()).toBeNull();
      expect(client.serverStatus()).toEqual(mockResponse);
      expect(client.bootVerified()).toBe(false);
      expect(client.executionReady()).toBe(false);
    });
  });
});
