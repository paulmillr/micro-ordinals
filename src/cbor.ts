import * as P from 'micro-packed';
import { utils } from '@scure/btc-signer';

type Bytes = Uint8Array;

// Binary JSON-like encoding: [RFC 7049](https://www.rfc-editor.org/rfc/rfc7049)
// And partially [RFC 8949](https://www.rfc-editor.org/rfc/rfc8949.html): without tagged values.
// Used for metadata encoding in ordinals and passkeys. Complex, but efficient encoding.

const isNegZero = (x: number) => x === 0 && 1 / x < 0;

// Float16Array is not available in JS as per Apr 2024.
// For now, we implement it using RFC 8949 like technique,
// while preserving Infinity and NaN. f32 rounding would be too slow.
// https://github.com/tc39/proposal-float16array
const F16BE = P.wrap({
  encodeStream(w, value: number) {
    // We simple encode popular values as bytes
    if (value === Infinity) return w.bytes(new Uint8Array([0x7c, 0x00]));
    if (value === -Infinity) return w.bytes(new Uint8Array([0xfc, 0x00]));
    if (Number.isNaN(value)) return w.bytes(new Uint8Array([0x7e, 0x00]));
    if (isNegZero(value)) return w.bytes(new Uint8Array([0x80, 0x00]));
    throw w.err('f16: not implemented');
  },
  decodeStream: (r) => {
    // decode_half from RFC 8949
    const half = P.U16BE.decodeStream(r);
    const exp = (half & 0x7c00) >> 10;
    const mant = half & 0x03ff;
    let val: number;
    if (exp === 0) val = 6.103515625e-5 * (mant / 1024);
    else if (exp !== 31) val = Math.pow(2, exp - 15) * (1 + mant / 1024);
    else val = mant ? NaN : Infinity;
    return half & 0x8000 ? -val : val;
  },
});

const INFO = P.bits(5); // additional info
const U64LEN = P.apply(P.U64BE, P.coders.numberBigint);

// Number/lengths limits
const CBOR_LIMITS: Record<
  number,
  [number | bigint, P.CoderType<number> | P.CoderType<bigint>, P.CoderType<number>]
> = {
  24: [2 ** 8 - 1, P.U8, P.U8],
  25: [2 ** 16 - 1, P.U16BE, P.U16BE],
  26: [2 ** 32 - 1, P.U32BE, P.U32BE],
  27: [2n ** 64n - 1n, P.U64BE, U64LEN],
};

const cborUint = P.wrap({
  encodeStream(w, value: number | bigint) {
    if (value < 24) return INFO.encodeStream(w, typeof value === 'bigint' ? Number(value) : value);
    for (const ai in CBOR_LIMITS) {
      const [limit, intCoder, _] = CBOR_LIMITS[ai];
      if (value > limit) continue;
      INFO.encodeStream(w, Number(ai));
      return (intCoder.encodeStream as any)(w, value);
    }
    throw w.err(`cbor/uint: wrong value=${value}`);
  },
  decodeStream(r) {
    const ai = INFO.decodeStream(r);
    if (ai < 24) return ai;
    const intCoder = CBOR_LIMITS[ai][1];
    if (!intCoder) throw r.err(`cbor/uint wrong additional information=${ai}`);
    return intCoder.decodeStream(r);
  },
});

const cborNegint = P.wrap({
  encodeStream: (w, v: number | bigint) =>
    cborUint.encodeStream(w, typeof v === 'bigint' ? -(v + 1n) : -(v + 1)),
  decodeStream(r) {
    const v = cborUint.decodeStream(r);
    return typeof v === 'bigint' ? -1n - v : -1 - v;
  },
});

const cborArrLength = <T>(inner: P.CoderType<T>): P.CoderType<T[]> =>
  P.wrap({
    encodeStream(w, value: T[]) {
      if (value.length < 24) {
        INFO.encodeStream(w, value.length);
        P.array(value.length, inner).encodeStream(w, value);
        return;
      }
      for (const ai in CBOR_LIMITS) {
        const [limit, _, lenCoder] = CBOR_LIMITS[ai];
        if (value.length < limit) {
          INFO.encodeStream(w, Number(ai));
          P.array(lenCoder, inner).encodeStream(w, value);
          return;
        }
      }
      throw w.err(`cbor/lengthArray: wrong value=${value}`);
    },
    decodeStream(r): T[] {
      const ai = INFO.decodeStream(r);
      if (ai < 24) return P.array(ai, inner).decodeStream(r);
      // array can have indefinite-length
      if (ai === 31) return P.array(new Uint8Array([0xff]), inner).decodeStream(r);
      const lenCoder = CBOR_LIMITS[ai][2];
      if (!lenCoder) throw r.err(`cbor/lengthArray wrong length=${ai}`);
      return P.array(lenCoder, inner).decodeStream(r);
    },
  });

// for strings/bytestrings
const cborLength = <T>(
  fn: (len: P.Length) => P.CoderType<T>,
  // Indefinity-length strings accept other elements with different types, we validate that later
  def: P.CoderType<any>,
): P.CoderType<T | T[]> =>
  P.wrap({
    encodeStream(w, value: T | T[]) {
      if (Array.isArray(value))
        throw new Error('cbor/length: encoding indefinite-length strings not supported');
      const bytes = fn(null).encode(value);
      if (bytes.length < 24) {
        INFO.encodeStream(w, bytes.length);
        w.bytes(bytes);
        return;
      }
      for (const ai in CBOR_LIMITS) {
        const [limit, _, lenCoder] = CBOR_LIMITS[ai];
        if (bytes.length < limit) {
          INFO.encodeStream(w, Number(ai));
          lenCoder.encodeStream(w, bytes.length);
          w.bytes(bytes);
          return;
        }
      }
      throw w.err(`cbor/lengthArray: wrong value=${value}`);
    },
    decodeStream(r): T | T[] {
      const ai = INFO.decodeStream(r);
      if (ai < 24) return fn(ai).decodeStream(r);
      if (ai === 31) return P.array(new Uint8Array([0xff]), def).decodeStream(r);
      const lenCoder = CBOR_LIMITS[ai][2];
      if (!lenCoder) throw r.err(`cbor/length wrong length=${ai}`);
      return fn(lenCoder).decodeStream(r);
    },
  });

const cborSimple: P.CoderType<boolean | null | undefined | number> = P.wrap({
  encodeStream(w, value) {
    if (value === false) return INFO.encodeStream(w, 20);
    if (value === true) return INFO.encodeStream(w, 21);
    if (value === null) return INFO.encodeStream(w, 22);
    if (value === undefined) return INFO.encodeStream(w, 23);
    if (typeof value !== 'number') throw w.err(`cbor/simple: wrong value type=${typeof value}`);
    // Basic values encoded as f16
    if (isNegZero(value) || Number.isNaN(value) || value === Infinity || value === -Infinity) {
      INFO.encodeStream(w, 25);
      return F16BE.encodeStream(w, value);
    }
    // If can be encoded as F32 without rounding
    if (Math.fround(value) === value) {
      INFO.encodeStream(w, 26);
      return P.F32BE.encodeStream(w, value);
    }
    INFO.encodeStream(w, 27);
    return P.F64BE.encodeStream(w, value);
  },
  decodeStream(r) {
    const ai = INFO.decodeStream(r);
    if (ai === 20) return false;
    if (ai === 21) return true;
    if (ai === 22) return null;
    if (ai === 23) return undefined;
    // ai === 24 is P.U8 with simple, reserved
    if (ai === 25) return F16BE.decodeStream(r);
    if (ai === 26) return P.F32BE.decodeStream(r);
    if (ai === 27) return P.F64BE.decodeStream(r);
    throw r.err('cbor/simple: unassigned');
  },
});

export type CborValue =
  | { TAG: 'uint'; data: number | bigint }
  | { TAG: 'negint'; data: number | bigint }
  | { TAG: 'simple'; data: boolean | null | undefined | number }
  | { TAG: 'string'; data: string }
  | { TAG: 'bytes'; data: Bytes }
  | { TAG: 'array'; data: CborValue[] }
  | { TAG: 'map'; data: [CborValue][] }
  | { TAG: 'tag'; data: [CborValue, CborValue] };

const cborValue: P.CoderType<CborValue> = P.mappedTag(P.bits(3), {
  uint: [0, cborUint], // An unsigned integer in the range 0..264-1 inclusive.
  negint: [1, cborNegint], // A negative integer in the range -264..-1 inclusive
  bytes: [2, P.lazy(() => cborLength(P.bytes, cborValue))], // A byte string.
  string: [3, P.lazy(() => cborLength(P.string, cborValue))], // A text string (utf8)
  array: [4, cborArrLength(P.lazy(() => cborValue))], // An array of data items
  map: [5, P.lazy(() => cborArrLength(P.tuple([cborValue, cborValue])))], // A map of pairs of data items
  tag: [6, P.tuple([cborUint, P.lazy(() => cborValue)] as const)], // A tagged data item ("tag") whose tag number
  simple: [7, cborSimple], // Floating-point numbers and simple values, as well as the "break" stop code
});

export const CBOR = P.apply(cborValue, {
  encode(from: CborValue): any {
    let value = from.data;
    if (from.TAG === 'bytes') {
      if (utils.isBytes(value)) return value;
      const chunks = [];
      if (!Array.isArray(value))
        throw new Error(`CBOR: wrong indefinite-length bytestring=${value}`);
      for (const c of value as any) {
        if (c.TAG !== 'bytes' || !utils.isBytes(c.data))
          throw new Error(`CBOR: wrong indefinite-length bytestring=${c}`);
        chunks.push(c.data);
      }
      return utils.concatBytes(...chunks);
    }
    if (from.TAG === 'string') {
      if (typeof value === 'string') return value;
      if (!Array.isArray(value)) throw new Error(`CBOR: wrong indefinite-length string=${value}`);
      let res = '';
      for (const c of value as any) {
        if (c.TAG !== 'string' || typeof c.data !== 'string')
          throw new Error(`CBOR: wrong indefinite-length string=${c}`);
        res += c.data;
      }
      return res;
    }
    if (from.TAG === 'array' && Array.isArray(value)) value = value.map((i: any) => this.encode(i));
    if (from.TAG === 'map' && typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        (from.data as any).map(([k, v]: [any, any]) => [this.encode(k), this.encode(v)]),
      );
    }
    if (from.TAG === 'tag') throw new Error('not implemented');
    return value;
  },
  decode(data: any): any {
    if (typeof data === 'bigint') {
      return data < 0n ? { TAG: 'negint', data } : { TAG: 'uint', data };
    }
    if (typeof data === 'string') return { TAG: 'string', data };
    if (utils.isBytes(data)) return { TAG: 'bytes', data };
    if (Array.isArray(data)) return { TAG: 'array', data: data.map((i) => this.decode(i)) };
    if (typeof data === 'number' && Number.isSafeInteger(data) && !isNegZero(data)) {
      return data < 0 ? { TAG: 'negint', data } : { TAG: 'uint', data };
    }
    if (
      typeof data === 'boolean' ||
      typeof data === 'number' ||
      data === null ||
      data === undefined
    ) {
      return { TAG: 'simple', data: data };
    }
    if (typeof data === 'object') {
      return {
        TAG: 'map',
        data: Object.entries(data).map((kv) => kv.map((i) => this.decode(i))),
      };
    }
    throw new Error('unknown type');
  },
});
