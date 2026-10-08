import {
  IDisplayOutputBackend,
  IFramebuffer,
  ISystemRenderer,
} from './types';

export class SystemRenderer implements ISystemRenderer {
  readonly framebuffer: IFramebuffer;
  private attachedBackend: IDisplayOutputBackend | null = null;

  constructor(framebuffer: IFramebuffer) {
    this.framebuffer = framebuffer;
  }

  attachOutputBackend(backend: IDisplayOutputBackend): void {
    if (
      backend.targetWidth !== this.framebuffer.width ||
      backend.targetHeight !== this.framebuffer.height
    ) {
      throw new Error(
        `Backend dimension mismatch: expected ${this.framebuffer.width}x${this.framebuffer.height}, received ${backend.targetWidth}x${backend.targetHeight}`
      );
    }
    this.attachedBackend = backend;
    // Initial present to sync current framebuffer state
    backend.present(this.framebuffer);
  }

  detachOutputBackend(): void {
    this.attachedBackend = null;
  }

  getAttachedBackend(): IDisplayOutputBackend | null {
    return this.attachedBackend;
  }

  renderFrame(): boolean {
    if (!this.attachedBackend) {
      return false;
    }
    if (this.framebuffer.isDirty()) {
      this.attachedBackend.present(this.framebuffer);
      this.framebuffer.clearDirty();
      return true;
    }
    return false;
  }

  flush(): void {
    if (this.attachedBackend) {
      this.attachedBackend.present(this.framebuffer);
      this.framebuffer.clearDirty();
    }
  }
}
