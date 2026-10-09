/**
 * Core type primitives for the Fabric Dessert virtual hardware platform.
 */

export type Address64 = bigint;
export type Size64 = bigint;

export const MIN_ADDRESS_64: Address64 = 0n;
export const MAX_ADDRESS_64: Address64 = 0xffff_ffff_ffff_ffffn;
export const ADDRESS_SPACE_SIZE_64: Size64 = 0x1_0000_0000_0000_0000n; // 2^64n

export function isValidAddress64(addr: unknown): addr is Address64 {
  return typeof addr === 'bigint' && addr >= MIN_ADDRESS_64 && addr <= MAX_ADDRESS_64;
}

export function assertValidAddress64(addr: Address64, context = 'Address'): Address64 {
  if (typeof addr !== 'bigint' || addr < MIN_ADDRESS_64 || addr > MAX_ADDRESS_64) {
    const hex = typeof addr === 'bigint' ? `0x${addr.toString(16)}` : String(addr);
    throw new Error(
      `${context} out of 64-bit physical address range [0, 0xFFFFFFFFFFFFFFFF]: ${hex}`
    );
  }
  return addr;
}

export function assertValidRegionRange(
  baseAddress: Address64,
  size: Size64,
  context = 'Region'
): void {
  assertValidAddress64(baseAddress, `${context} baseAddress`);
  if (size <= 0n) {
    throw new Error(`${context} size must be > 0, received ${size}`);
  }
  if (size > ADDRESS_SPACE_SIZE_64) {
    throw new Error(
      `${context} size 0x${size.toString(16)} exceeds 64-bit physical address space capacity`
    );
  }
  const lastByteAddress = baseAddress + size - 1n;
  if (lastByteAddress > MAX_ADDRESS_64 || baseAddress + size > ADDRESS_SPACE_SIZE_64) {
    throw new Error(
      `${context} end boundary 0x${(baseAddress + size).toString(16)} exceeds 64-bit physical address space limit 0x${MAX_ADDRESS_64.toString(16)}`
    );
  }
}

export function toAddress64(val: number | bigint | string): Address64 {
  let addr: bigint;
  if (typeof val === 'bigint') {
    addr = val;
  } else if (typeof val === 'string') {
    try {
      addr = BigInt(val);
    } catch {
      throw new Error(`Invalid address string format: "${val}"`);
    }
  } else if (typeof val === 'number') {
    if (!Number.isSafeInteger(val)) {
      throw new Error(`Invalid address number value: ${val}`);
    }
    addr = BigInt(val);
  } else {
    throw new Error(`Invalid address value: ${String(val)}`);
  }
  return assertValidAddress64(addr, 'Address value');
}

export function formatAddress(addr: Address64): string {
  return `0x${addr.toString(16).padStart(16, '0')}`;
}
