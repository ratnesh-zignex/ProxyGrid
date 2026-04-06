
/**
 * Dictionary Encoder
 * 
 * Why dictionary encoding reduces memory:
 * Instead of storing the same string literal "California" 50,000 times (which would take ~10 bytes * 50,000 = 500KB + object overhead),
 * we store it ONCE in a dictionary array, and store a 1-byte index (Uint8) 50,000 times (50KB).
 * This results in massive memory savings (10x+) and better cache locality for the CPU.
 */
export class DictionaryEncoder {
  static encode(data: string[]): { values: string[], index: Uint8Array | Uint16Array } {
    const map = new Map<string, number>();
    const values: string[] = [];
    
    // First pass: Build unique dictionary
    for (const str of data) {
      if (!map.has(str)) {
        map.set(str, values.length);
        values.push(str);
      }
    }

    // Determine smallest array type needed
    const count = values.length;
    let index: Uint8Array | Uint16Array;
    
    if (count < 256) {
      index = new Uint8Array(data.length);
    } else {
      index = new Uint16Array(data.length);
    }

    // Second pass: Map strings to indices
    for (let i = 0; i < data.length; i++) {
      index[i] = map.get(data[i])!;
    }

    return { values, index };
  }
}
