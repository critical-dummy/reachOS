import {TestBed} from '@angular/core/testing';
import {App} from './app';
import {FabricDessertHost} from './fabric-dessert-host';
import {FabricDessertInputBridge} from './input-bridge';
import {RuntimeLifecycleState} from '../fabric-dessert';

describe('App', () => {
  let host: FabricDessertHost;
  let inputBridge: FabricDessertInputBridge;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();

    host = TestBed.inject(FabricDessertHost);
    inputBridge = TestBed.inject(FabricDessertInputBridge);
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should auto-boot virtual device to RUNNING when canvas is attached', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 2424;
    canvas.getContext = (() => ({
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: () => undefined,
      imageSmoothingEnabled: false,
    })) as unknown as typeof canvas.getContext;

    expect(host.state()).toBe(RuntimeLifecycleState.READY);
    host.attachCanvas(canvas);
    expect(host.state()).toBe(RuntimeLifecycleState.RUNNING);
  });

  it('should correctly support pause, resume, and restart controls', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 2424;
    canvas.getContext = (() => ({
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: () => undefined,
      imageSmoothingEnabled: false,
    })) as unknown as typeof canvas.getContext;
    host.attachCanvas(canvas);

    expect(host.state()).toBe(RuntimeLifecycleState.RUNNING);

    host.pause();
    expect(host.state()).toBe(RuntimeLifecycleState.PAUSED);

    host.resume();
    expect(host.state()).toBe(RuntimeLifecycleState.RUNNING);

    host.restart();
    expect(host.state()).toBe(RuntimeLifecycleState.RUNNING);

    host.powerToggle();
    expect(host.state()).toBe(RuntimeLifecycleState.STOPPED);

    host.powerToggle();
    expect(host.state()).toBe(RuntimeLifecycleState.RUNNING);
  });

  it('should handle input bridge characters and keys', () => {
    expect(inputBridge.guestInputAttached).toBe(false);
    expect(inputBridge.eventStream().length).toBe(0);

    inputBridge.sendChar('a');
    inputBridge.sendKey('Backspace');
    inputBridge.sendChar('한');

    const stream = inputBridge.eventStream();
    expect(stream.length).toBe(3);
    expect(stream[0].value).toBe('a');
    expect(stream[1].value).toBe('Backspace');
    expect(stream[2].value).toBe('한');
  });
});

