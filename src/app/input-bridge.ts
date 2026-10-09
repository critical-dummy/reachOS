import {Injectable, signal} from '@angular/core';

export interface ClientInputEvent {
  readonly type: 'char' | 'key';
  readonly value: string;
  readonly timestamp: number;
}

/**
 * Host client input bridge.
 *
 * Captures user text and keystrokes from the host browser.
 * Note: No hardware keyboard controller is currently registered on the
 * Fabric Dessert device bus (guestInputAttached: false). Inputs are recorded
 * here rather than masquerading as guest hardware MMIO delivery.
 */
@Injectable({
  providedIn: 'root',
})
export class FabricDessertInputBridge {
  readonly guestInputAttached = false;
  private readonly events = signal<readonly ClientInputEvent[]>([]);

  readonly eventStream = this.events.asReadonly();

  sendChar(char: string): void {
    if (!char) return;
    this.events.update((list) => [
      ...list.slice(-49),
      {type: 'char', value: char, timestamp: Date.now()},
    ]);
  }

  sendKey(key: string): void {
    if (!key) return;
    this.events.update((list) => [
      ...list.slice(-49),
      {type: 'key', value: key, timestamp: Date.now()},
    ]);
  }

  clear(): void {
    this.events.set([]);
  }
}
