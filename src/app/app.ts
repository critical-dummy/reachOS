import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {MatIconModule} from '@angular/material/icon';
import {RuntimeLifecycleState} from '../fabric-dessert';
import {FabricDessertHost} from './fabric-dessert-host';
import {FabricDessertInputBridge} from './input-bridge';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly host = inject(FabricDessertHost);
  protected readonly inputBridge = inject(FabricDessertInputBridge);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('displayCanvas');
  protected readonly hiddenInputRef = viewChild<ElementRef<HTMLInputElement>>('hiddenInput');

  protected readonly hasSideSpace = signal(false);
  protected readonly showMobileKeyboard = signal(false);

  protected readonly isRunning = computed(
    () => this.host.state() === RuntimeLifecycleState.RUNNING
  );
  protected readonly isPaused = computed(
    () => this.host.state() === RuntimeLifecycleState.PAUSED
  );
  protected readonly isStopped = computed(
    () => this.host.state() === RuntimeLifecycleState.STOPPED
  );

  protected readonly stateLabel = computed(() => {
    switch (this.host.state()) {
      case RuntimeLifecycleState.RUNNING:
        return 'RUNNING';
      case RuntimeLifecycleState.PAUSED:
        return 'PAUSED';
      case RuntimeLifecycleState.STOPPED:
        return 'STOPPED';
      default:
        return 'READY';
    }
  });

  protected readonly powerTitle = computed(() =>
    this.isRunning() || this.isPaused() ? 'Power Off' : 'Power On'
  );
  protected readonly playPauseTitle = computed(() =>
    this.isRunning() ? 'Pause' : 'Resume'
  );

  private isComposing = false;

  constructor() {
    afterNextRender(() => {
      const canvasEl = this.canvasRef()?.nativeElement;
      if (canvasEl instanceof HTMLCanvasElement) {
        this.host.attachCanvas(canvasEl);
      }

      this.showMobileKeyboard.set(this.checkMobileInputSupport());
      this.updateSideSpace();

      const onResize = () => {
        this.updateSideSpace();
      };
      window.addEventListener('resize', onResize);

      let resizeObserver: ResizeObserver | null = null;
      if (canvasEl && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          this.updateSideSpace();
        });
        resizeObserver.observe(canvasEl);
      }

      this.destroyRef.onDestroy(() => {
        window.removeEventListener('resize', onResize);
        if (resizeObserver) {
          resizeObserver.disconnect();
        }
      });
    });
  }

  private updateSideSpace(): void {
    if (typeof window === 'undefined') return;
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const availableSide = (window.innerWidth - rect.width) / 2;
    // Capsule width (40px) + offset gap (14px) + margin buffer (8px) = 62px
    this.hasSideSpace.set(availableSide >= 62);
  }

  private checkMobileInputSupport(): boolean {
    if (
      typeof window === 'undefined' ||
      typeof navigator === 'undefined' ||
      typeof document === 'undefined'
    ) {
      return false;
    }

    // Input device characteristic check: must have touch / coarse pointer
    const hasCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    if (!hasCoarsePointer && !hasTouch) {
      // Desktop browser without coarse/touch input
      return false;
    }

    // Must support standard DOM text input focus for native virtual keyboard trigger
    const canFocus =
      typeof HTMLInputElement !== 'undefined' &&
      typeof HTMLInputElement.prototype.focus === 'function';

    return canFocus;
  }

  protected togglePower(): void {
    this.host.powerToggle();
  }

  protected togglePlayPause(): void {
    if (this.isRunning()) {
      this.host.pause();
    } else {
      this.host.start();
    }
  }

  protected restart(): void {
    this.host.restart();
  }

  protected openKeyboard(): void {
    const input = this.hiddenInputRef()?.nativeElement;
    if (input) {
      input.focus({preventScroll: true});
    }
  }

  protected onCompositionStart(): void {
    this.isComposing = true;
  }

  protected onCompositionUpdate(): void {
    // Preserve composing state without premature character dispatch
  }

  protected onCompositionEnd(e: CompositionEvent): void {
    this.isComposing = false;
    if (e.data) {
      this.inputBridge.sendChar(e.data);
    }
    this.resetInput();
  }

  protected onKeyDown(e: KeyboardEvent): void {
    if (this.isComposing || e.isComposing || e.keyCode === 229) {
      return;
    }
    if (e.key === 'Backspace') {
      this.inputBridge.sendKey('Backspace');
    } else if (e.key === 'Enter') {
      this.inputBridge.sendKey('Enter');
    }
  }

  protected onInput(e: Event): void {
    if (this.isComposing) {
      return;
    }
    const inputEvent = e as InputEvent;
    if (inputEvent.data) {
      this.inputBridge.sendChar(inputEvent.data);
    }
    this.resetInput();
  }

  private resetInput(): void {
    const input = this.hiddenInputRef()?.nativeElement;
    if (input) {
      input.value = '';
    }
  }
}

