import {Injectable, computed, signal} from '@angular/core';
import {
  BrowserRuntimeCapabilities,
  detectBrowserRuntimeCapabilities,
} from './runtime-capabilities';

export interface QemuServerStatusSummary {
  readonly requiredCount: number;
  readonly presentRequiredCount: number;
  readonly missingRequiredCount: number;
  readonly totalCheckedCount: number;
}

export interface QemuServerStatusResponse {
  readonly status: 'assets_missing' | 'assets_incomplete' | 'assets_present_unverified';
  readonly bootVerified: false;
  readonly executionReady: false;
  readonly arch: string;
  readonly assetDirectory: string;
  readonly directoryExists: boolean;
  readonly summary: QemuServerStatusSummary;
  readonly missingRequired: readonly string[];
  readonly presentFiles: readonly string[];
  readonly assets: readonly {
    readonly filename: string;
    readonly expectedFilename: string;
    readonly detectedFilename: string | null;
    readonly description: string;
    readonly category: 'runtime' | 'guest';
    readonly required: boolean;
    readonly upstreamStatus: 'confirmed' | 'provisional';
    readonly exists: boolean;
    readonly sizeBytes: number | null;
  }[];
  readonly notes: string;
}

/**
 * Client service managing QEMU runtime capability inspection and server asset status.
 *
 * Keeps distinct boundaries between:
 * 1. Browser runtime capabilities (WebAssembly, SharedArrayBuffer, isolation).
 * 2. Server asset presence on disk (/api/qemu/status).
 * 3. Execution readiness (always false until client engine is implemented).
 * 4. Guest Linux boot verification (always false until guest boot demonstrated).
 */
@Injectable({
  providedIn: 'root',
})
export class QemuStatusClient {
  readonly capabilities = signal<BrowserRuntimeCapabilities>(
    detectBrowserRuntimeCapabilities()
  );

  readonly serverStatus = signal<QemuServerStatusResponse | null>(null);
  readonly serverError = signal<string | null>(null);
  readonly isLoading = signal<boolean>(false);

  // Execution readiness and Linux boot remain explicitly false
  readonly bootVerified = computed(() => false);
  readonly executionReady = computed(() => false);

  readonly isFullyCapable = computed(
    () => this.capabilities().multithreadedWasmSupported
  );

  constructor() {
    this.refreshCapabilities();
  }

  refreshCapabilities(): void {
    this.capabilities.set(detectBrowserRuntimeCapabilities());
  }

  async fetchServerStatus(customFetch?: typeof fetch): Promise<void> {
    if (typeof window === 'undefined' && !customFetch) {
      return;
    }

    const fetchFn = customFetch ?? (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) {
      this.serverError.set('Fetch API unavailable in this context.');
      return;
    }

    this.isLoading.set(true);
    this.serverError.set(null);

    try {
      const response = await fetchFn('/api/qemu/status');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as QemuServerStatusResponse;
      this.serverStatus.set(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.serverError.set(`Failed to retrieve QEMU status: ${msg}`);
      this.serverStatus.set(null);
    } finally {
      this.isLoading.set(false);
    }
  }
}
