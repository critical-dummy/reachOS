/**
 * Core type primitives for the Fabric Dessert virtual hardware platform.
 */

export type Address64 = bigint;
export type Size64 = bigint;

export function toAddress64(val: number | bigint | string): Address64 {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string') {
    if (val.startsWith('0x') || val.startsWith('0X')) {
      return BigInt(val);
    }
    return BigInt(val);
  }
  return BigInt(Math.floor(val));
}

export function formatAddress(addr: Address64): string {
  return `0x${addr.toString(16).padStart(16, '0')}`;
}
