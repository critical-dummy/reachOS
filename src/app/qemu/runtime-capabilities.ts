/**
 * Browser runtime capabilities detection for WebAssembly and QEMU-WASM.
 *
 * Evaluates the client environment to determine whether the browser supports
 * basic WebAssembly, Web Workers, SharedArrayBuffer, and cross-origin isolation
 * required by the upstream multithreaded QEMU-WASM build.
 */

export interface BrowserRuntimeCapabilities {
  /** Whether the code is running inside a browser window context (false in SSR/Node) */
  readonly isBrowser: boolean;
  /** Whether window.isSecureContext is true */
  readonly isSecureContext: boolean;
  /** Whether the global WebAssembly object is defined */
  readonly hasWebAssembly: boolean;
  /** Whether WebAssembly.validate is a callable function */
  readonly hasWasmValidate: boolean;
  /** Whether SharedArrayBuffer constructor is available */
  readonly hasSharedArrayBuffer: boolean;
  /** Whether window.crossOriginIsolated is true */
  readonly isCrossOriginIsolated: boolean;
  /** Whether Web Worker constructor is available */
  readonly hasWebWorker: boolean;
  /** Basic single-threaded WebAssembly execution is possible */
  readonly basicWasmSupported: boolean;
  /** All prerequisites for upstream multithreaded QEMU-WASM (pthreads + SAB) are satisfied */
  readonly multithreadedWasmSupported: boolean;
  /** Specific limitation descriptions for unsatisfied capabilities */
  readonly limitations: readonly string[];
  /** Actionable next steps for the user if capabilities are restricted */
  readonly recommendedAction: string | null;
}

/**
 * Detects browser runtime capabilities.
 * Accepts an optional custom window object for unit testing and SSR isolation.
 */
export function detectBrowserRuntimeCapabilities(
  customWindow?: Window | null
): BrowserRuntimeCapabilities {
  const win =
    customWindow !== undefined
      ? customWindow
      : typeof window !== 'undefined'
        ? window
        : null;

  // Non-browser or SSR environment
  if (!win) {
    return {
      isBrowser: false,
      isSecureContext: false,
      hasWebAssembly: false,
      hasWasmValidate: false,
      hasSharedArrayBuffer: false,
      isCrossOriginIsolated: false,
      hasWebWorker: false,
      basicWasmSupported: false,
      multithreadedWasmSupported: false,
      limitations: ['Non-browser execution context (SSR or Node.js runtime).'],
      recommendedAction: null,
    };
  }

  const isSecure =
    typeof win.isSecureContext === 'boolean' ? win.isSecureContext : false;

  const winWasm = (
    win as unknown as {
      WebAssembly?: {validate?: (bytes: BufferSource) => boolean};
    }
  ).WebAssembly;

  const hasWasm = typeof winWasm !== 'undefined' && winWasm !== null;

  const hasValidate =
    hasWasm && typeof winWasm?.validate === 'function';

  const hasSAB = typeof (win as unknown as {SharedArrayBuffer?: unknown})
    .SharedArrayBuffer !== 'undefined';

  const isIsolated =
    typeof (win as unknown as {crossOriginIsolated?: unknown})
      .crossOriginIsolated === 'boolean'
      ? Boolean(
          (win as unknown as {crossOriginIsolated?: boolean})
            .crossOriginIsolated
        )
      : false;

  const hasWorker =
    typeof (win as unknown as {Worker?: unknown}).Worker !== 'undefined';

  const basicWasmSupported = hasWasm && hasValidate;

  // Multithreaded QEMU-WASM requires WebAssembly, Workers, SharedArrayBuffer,
  // and an isolated secure browsing context.
  const multithreadedWasmSupported =
    basicWasmSupported && hasSAB && isIsolated && hasWorker && isSecure;

  const limitations: string[] = [];

  if (!hasWasm) {
    limitations.push('WebAssembly API is unavailable in this environment.');
  } else if (!hasValidate) {
    limitations.push(
      'WebAssembly.validate is missing; dynamic module verification is unsupported.'
    );
  }

  if (!hasWorker) {
    limitations.push(
      'Web Worker API is unavailable; background emulation threads cannot be spawned.'
    );
  }

  if (!isSecure) {
    limitations.push(
      'Context is not secure (HTTP). Cross-origin isolation requires HTTPS or localhost.'
    );
  }

  if (!isIsolated) {
    limitations.push(
      'Cross-Origin Isolation is disabled (window.crossOriginIsolated is false).'
    );
  }

  if (!hasSAB) {
    limitations.push(
      'SharedArrayBuffer is undefined, preventing multithreaded WebAssembly pthreads.'
    );
  }

  let recommendedAction: string | null = null;
  if (!multithreadedWasmSupported) {
    if (!isIsolated || !hasSAB) {
      recommendedAction =
        'If running inside an embedded preview iframe, try opening the application directly in a standalone browser tab and re-checking. (Note: A standalone tab may satisfy isolation if the parent iframe was the only restriction, but will not guarantee isolation in browsers without COOP/COEP support.)';
    } else if (!hasWasm) {
      recommendedAction =
        'Please switch to a modern browser that supports WebAssembly.';
    } else if (!hasWorker) {
      recommendedAction =
        'Please switch to a browser that supports standard Web Workers.';
    }
  }

  return {
    isBrowser: true,
    isSecureContext: isSecure,
    hasWebAssembly: hasWasm,
    hasWasmValidate: hasValidate,
    hasSharedArrayBuffer: hasSAB,
    isCrossOriginIsolated: isIsolated,
    hasWebWorker: hasWorker,
    basicWasmSupported,
    multithreadedWasmSupported,
    limitations,
    recommendedAction,
  };
}
