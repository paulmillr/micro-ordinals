import { type Coder, hex, type TArg, type TRet, utf8 } from '@scure/base';
import {
  type CustomScript,
  MAX_SCRIPT_BYTE_LENGTH,
  type OptScript,
  Script,
  type ScriptType,
  utils,
} from '@scure/btc-signer';
import { PubT, validatePubkey } from '@scure/btc-signer/utils.js';
import * as P from 'micro-packed';
import { CBOR } from './cbor.ts';

type Bytes = Uint8Array;
// Ordinals envelopes are tagged with the literal ASCII protocol marker "ord".
const PROTOCOL_ID = /* @__PURE__ */ utf8.decode('ord');

// Split payloads into 520-byte push chunks; returned slices are subarray views.
function splitChunks(buf: TArg<Bytes>): TRet<Bytes[]> {
  const res: Bytes[] = [];
  for (let i = 0; i < buf.length; i += MAX_SCRIPT_BYTE_LENGTH)
    res.push(buf.subarray(i, i + MAX_SCRIPT_BYTE_LENGTH));
  return res as TRet<Bytes[]>;
}

// Raw ids are txid bytes in internal little-endian order plus a minimally encoded u32 index.
const RawInscriptionId = /* @__PURE__ */ P.tuple([
  P.bytes(32, true),
  P.apply(P.bigint(4, true, false, false), P.coders.numberBigint),
] as const);

/**
 * Ordinals inscription identifier coder.
 * @example
 * Encode the txid-and-index string form used to reference an inscription.
 * ```ts
 * InscriptionId.encode('0000000000000000000000000000000000000000000000000000000000000000i0');
 * ```
 */
export const InscriptionId: TRet<P.Coder<string, Bytes>> = /* @__PURE__ */ Object.freeze({
  encode(data: string) {
    if (typeof data !== 'string')
      throw new TypeError(`InscriptionId.encode: expected string, got ${typeof data}`);
    const [txId, index] = data.split('i', 2);
    const parsed = Number(index);
    // Keep one canonical string form: decimal index only.
    // No sign, padding, fraction, or whitespace.
    if (`${parsed}` !== index || !Number.isSafeInteger(parsed) || parsed < 0)
      throw new RangeError(`InscriptionId wrong index: ${index}`);
    return RawInscriptionId.encode([hex.decode(txId), parsed]);
  },
  decode(data: TArg<Bytes>) {
    const [txId, index] = RawInscriptionId.decode(data);
    return `${hex.encode(txId)}i${index}`;
  },
}) as TRet<P.Coder<string, Bytes>>;

const TagEnum = {
  // Would be simpler to have body tag here,
  // but body chunks don't have body tag near them
  contentType: 1,
  pointer: 2,
  parent: 3,
  metadata: 5,
  metaprotocol: 7,
  contentEncoding: 9,
  delegate: 11,
  rune: 13,
  note: 15,
  // Unrecognized even tag makes inscription unbound
  // unbound: 66,
  // Odd fields are ignored
  // nop: 255,
};

const TagCoderInternal = /* @__PURE__ */ P.map(P.U8, TagEnum);
type TagName = keyof typeof TagEnum;
type TagRaw = { tag: Bytes; data: Bytes };
/** Mapping of inscription tag names to their coders. */
export type TagCodersType = {
  /** Inscription pointer tag stored as an unsigned 64-bit integer. */
  pointer: P.CoderType<bigint>;
  /** MIME type for the inscription body. */
  contentType: P.CoderType<string>;
  /** Parent inscription reference. */
  parent: P.Coder<string, Uint8Array>;
  /** CBOR metadata payload. */
  metadata: P.CoderType<any>;
  /** Secondary protocol name carried by the inscription. */
  metaprotocol: P.CoderType<string>;
  /** Content-Encoding value for the inscription body. */
  contentEncoding: P.CoderType<string>;
  /** Delegated inscription reference. */
  delegate: P.Coder<string, Uint8Array>;
  /** Rune identifier stored as an unsigned 128-bit integer. */
  rune: P.CoderType<bigint>;
  /** Free-form note text. */
  note: P.CoderType<string>;
};

const TagCoders: TagCodersType = /* @__PURE__ */ (() =>
  Object.freeze({
    pointer: Object.freeze(P.bigint(8, true, false, false)), // U64
    contentType: Object.freeze(P.string(null)),
    parent: InscriptionId,
    metadata: CBOR,
    metaprotocol: Object.freeze(P.string(null)),
    contentEncoding: Object.freeze(P.string(null)),
    delegate: InscriptionId,
    rune: Object.freeze(P.bigint(16, true, false, false)), // U128
    note: Object.freeze(P.string(null)),
    // unbound: P.bytes(null),
    // nop: P.bytes(null),
  }))();

/** Parsed ordinals tag bag. */
export type Tags = Partial<{
  [K in keyof typeof TagCoders]: P.UnwrapCoder<(typeof TagCoders)[K]>;
}> & {
  unknown?: [Bytes, Bytes][];
};
// We can't use mappedTag here, because tags can be split in chunks
const TagCoder: P.Coder<TagRaw[], Tags> = /* @__PURE__ */ Object.freeze({
  encode(from: TArg<TagRaw[]>): TRet<Tags> {
    const tmp: Record<string, Bytes[]> = {};
    const unknown: [Bytes, Bytes][] = [];
    // collect tag parts
    for (const { tag, data } of from) {
      try {
        const tagName = TagCoderInternal.decode(tag);
        if (!tmp[tagName]) tmp[tagName] = [];
        tmp[tagName].push(data);
      } catch (e) {
        unknown.push([tag, data]);
      }
    }
    const res: Partial<Tags> = {};
    if (unknown.length) res.unknown = unknown;
    for (const field in tmp) {
      // Repeated known tags are chunk continuations; only parent remains multi-valued.
      if (field === 'parent' && tmp[field].length > 1) {
        res[field as TagName] = tmp[field].map((i) => TagCoders.parent.decode(i));
        continue;
      }
      res[field as TagName] = TagCoders[field as TagName].decode(utils.concatBytes(...tmp[field]));
    }
    return res as TRet<Tags>;
  },
  decode(to: TArg<Tags>): TRet<TagRaw[]> {
    const res: TagRaw[] = [];
    for (const field in to) {
      if (field === 'unknown') continue;
      const tagName = TagCoderInternal.encode(field);
      if (field === 'parent' && Array.isArray(to.parent)) {
        for (const p of to.parent) res.push({ tag: tagName, data: TagCoders.parent.encode(p) });
        continue;
      }
      let bytes = TagCoders[field as TagName].encode(to[field as TagName]);

      // Handle pointer = 0:
      if (field === 'pointer' && bytes.length === 0) {
        bytes = Uint8Array.of(0);
      }

      for (const data of splitChunks(bytes)) res.push({ tag: tagName, data });
    }
    if (to.unknown) {
      if (!Array.isArray(to.unknown))
        throw new TypeError('ordinals/TagCoder: unknown should be array');
      for (const [tag, data] of to.unknown) res.push({ tag, data });
    }
    return res as TRet<TagRaw[]>;
  },
});

/** Parsed ordinals inscription payload. */
export type Inscription = {
  /** Parsed inscription tags. */
  tags: Tags;
  /** Inscription body bytes. */
  body: Bytes;
  /** Whether the inscription was parsed from a cursed envelope. */
  cursed?: boolean;
};
type OutOrdinalRevealType = {
  type: 'tr_ord_reveal';
  pubkey: Bytes;
  inscriptions: Inscription[];
};

const parseEnvelopes = (script: ScriptType, pos = 0) => {
  if (typeof pos !== 'number')
    throw new TypeError(`parseInscription: expected pos number, got ${typeof pos}`);
  if (!Number.isSafeInteger(pos) || pos < 0)
    throw new RangeError(`parseInscription: wrong pos=${pos}`);
  const envelopes = [];
  // Inscriptions with broken parsing are called 'cursed' (stutter or pushnum)
  // Keep stutter sticky across following envelopes.
  // This matches ord's cursed-inscription classification.
  let stutter = false;
  main: for (; pos < script.length; pos++) {
    const instr = script[pos];
    if (instr !== 0) continue;
    if (script[pos + 1] !== 'IF') {
      if (script[pos + 1] === 0) stutter = true;
      continue main;
    }
    if (
      !utils.isBytes(script[pos + 2]) ||
      !P.utils.equalBytes(script[pos + 2] as any, PROTOCOL_ID)
    ) {
      if (script[pos + 2] === 0) stutter = true;
      continue main;
    }
    let pushnum = false;
    const payload: ScriptType = []; // bytes or 0
    for (let j = pos + 3; j < script.length; j++) {
      const op = script[j];
      // done
      if (op === 'ENDIF') {
        envelopes.push({ start: pos + 3, end: j, pushnum, payload, stutter });
        pos = j;
        break;
      }
      if (op === '1NEGATE') {
        pushnum = true;
        payload.push(new Uint8Array([0x81]));
        continue;
      }
      if (typeof op === 'number' && 1 <= op && op <= 16) {
        pushnum = true;
        payload.push(new Uint8Array([op]));
        continue;
      }
      if (utils.isBytes(op) || op === 0) {
        payload.push(op);
        continue;
      }
      stutter = false;
      break;
    }
  }
  return envelopes;
};

/**
 * Parses ordinals inscriptions from a script.
 * @param script - decoded bitcoin script
 * @param strict - require the exact reveal-script layout
 * @returns parsed inscriptions when the script contains valid envelopes
 * @throws If inscription tags or tag data are malformed inside the reveal script. {@link Error}
 * @throws On wrong argument types. {@link TypeError}
 * @throws On wrong argument ranges or values. {@link RangeError}
 * @example
 * Build a reveal script, then parse the inscriptions back out of the decoded script.
 * ```ts
 * import { parseInscriptions, p2tr_ord_reveal } from 'micro-ordinals';
 * import { Script } from '@scure/btc-signer';
 * import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * const privKey = randomPrivateKeyBytes();
 * const pubKey = pubSchnorr(privKey);
 * const reveal = p2tr_ord_reveal(pubKey, [
 *   { tags: { contentType: 'text/plain' }, body: new Uint8Array([1, 2, 3]) },
 * ]);
 * parseInscriptions(Script.decode(reveal.script));
 * ```
 */
export function parseInscriptions(
  script: ScriptType,
  strict = false
): TRet<Inscription[] | undefined> {
  // Strict mode backs OutOrdinalReveal.encode().
  // Malformed reveal layout must throw instead of leaking a partial codec object.
  if (strict) {
    validateXOnlyPubkey('parseInscription: strict mode', script[0] as Bytes);
    if (script[1] !== 'CHECKSIG')
      throw new Error('parseInscription: strict mode expected CHECKSIG at script[1]');
  }

  const envelopes = parseEnvelopes(script);
  const inscriptions: Inscription[] = [];
  // Check that all inscriptions are sequential inside script
  let pos = 5;
  for (const envelope of envelopes) {
    if (strict && (envelope.stutter || envelope.pushnum))
      throw new Error('parseInscription: strict mode cannot encode cursed envelopes');
    if (strict && envelope.start !== pos)
      throw new Error(
        `parseInscription: strict mode expected envelope at ${pos}, got ${envelope.start}`
      );
    const { payload } = envelope;
    let i = 0;
    const tags: TagRaw[] = [];
    for (; i < payload.length && payload[i] !== 0; i += 2) {
      const tag = payload[i];
      const data = payload[i + 1];
      if (!utils.isBytes(tag)) throw new Error('parseInscription: non-bytes tag');
      if (!utils.isBytes(data)) throw new Error('parseInscription: non-bytes tag data');
      tags.push({ tag, data });
    }
    while (payload[i] === 0 && i < payload.length) i++;

    const chunks = [];
    for (; i < payload.length; i++) {
      if (!utils.isBytes(payload[i])) break;
      chunks.push(payload[i] as Bytes);
    }
    inscriptions.push({
      tags: TagCoder.encode(tags),
      body: utils.concatBytes(...chunks),
      cursed: envelope.pushnum || envelope.stutter,
    });
    pos = envelope.end + 4;
  }
  if (pos - 3 !== script.length) {
    if (strict)
      throw new Error(
        `parseInscription: strict mode expected script length ${pos - 3}, got ${script.length}`
      );
    return;
  }
  return inscriptions as TRet<Inscription[]>;
}

/**
 * Parse inscriptions from reveal tx input witness (tx.inputs[0].finalScriptWitness)
 * @param witness - reveal input witness stack
 * @returns parsed inscriptions when the witness contains a reveal script
 * @throws If the decoded reveal script contains malformed inscription tags. {@link Error}
 * @throws On wrong witness argument types. {@link TypeError}
 * @throws On wrong witness stack length. {@link RangeError}
 * @example
 * Reuse the reveal-script slot from a taproot witness and parse the inscription payload back out.
 * ```ts
 * import { parseWitness, p2tr_ord_reveal } from 'micro-ordinals';
 * import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * const privKey = randomPrivateKeyBytes();
 * const pubKey = pubSchnorr(privKey);
 * const reveal = p2tr_ord_reveal(pubKey, [
 *   { tags: { contentType: 'text/plain' }, body: new Uint8Array([1, 2, 3]) },
 * ]);
 * const dummySig = new Uint8Array([0]);
 * const dummyControlBlock = new Uint8Array([0]);
 * parseWitness([dummySig, reveal.script, dummyControlBlock]);
 * ```
 */
export function parseWitness(witness: TArg<Bytes[]>): TRet<Inscription[] | undefined> {
  if (!Array.isArray(witness))
    throw new TypeError(`parseWitness: expected witness array, got ${typeof witness}`);
  // This helper only supports the repo's [sig, script, control-block] reveal witness shape.
  if (witness.length !== 3)
    throw new RangeError(`parseWitness: expected 3 witness items, got ${witness.length}`);
  // We don't validate other parts of witness here since we want to parse
  // as much stuff as possible. When creating inscription, it is done more strictly
  return parseInscriptions(Script.decode(witness[1])) as TRet<Inscription[] | undefined>;
}

const validateXOnlyPubkey = (name: string, pubkey: TArg<Bytes>) => {
  // BIP340 encodes public keys as 32 bytes; BIP342 treats 32-byte tapscript keys as BIP340 keys.
  if (!utils.isBytes(pubkey)) throw new TypeError(`${name}: expected pubkey bytes`);
  try {
    validatePubkey(pubkey, PubT.schnorr);
  } catch (e) {
    throw new RangeError(`${name}: expected valid 32-byte x-only pubkey`);
  }
};

/**
 * Custom script codec for ordinals reveal scripts.
 * @example
 * Decode the custom ordinals reveal structure back out of a bitcoin script.
 * ```ts
 * import { OutOrdinalReveal, p2tr_ord_reveal } from 'micro-ordinals';
 * import { Script } from '@scure/btc-signer';
 * import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * const privKey = randomPrivateKeyBytes();
 * const pubKey = pubSchnorr(privKey);
 * const reveal = p2tr_ord_reveal(pubKey, [
 *   { tags: { contentType: 'text/plain' }, body: new Uint8Array([1, 2, 3]) },
 * ]);
 * OutOrdinalReveal.encode(Script.decode(reveal.script));
 * ```
 */
export const OutOrdinalReveal: TRet<
  Coder<OptScript, OutOrdinalRevealType | undefined> & CustomScript
> = /* @__PURE__ */ Object.freeze({
  encode(from: ScriptType): TRet<OutOrdinalRevealType | undefined> {
    const res: Partial<OutOrdinalRevealType> = { type: 'tr_ord_reveal' };
    try {
      res.inscriptions = parseInscriptions(from, true);
      res.pubkey = from[0] as Bytes;
    } catch (e) {
      return;
    }
    return res as TRet<OutOrdinalRevealType>;
  },
  decode: (to: TArg<OutOrdinalRevealType>): OptScript => {
    if (to.type !== 'tr_ord_reveal') return;
    validateXOnlyPubkey('tr_ord_reveal/decode', to.pubkey);
    const out: ScriptType = [to.pubkey, 'CHECKSIG'];
    // `cursed` is parse-only metadata; the reveal script itself only carries tags and body bytes.
    for (const { tags, body } of to.inscriptions) {
      out.push(0, 'IF', PROTOCOL_ID);
      const rawTags = TagCoder.decode(tags);
      for (const tag of rawTags) out.push(tag.tag, tag.data);
      // Body
      out.push(0);
      for (const c of splitChunks(body)) out.push(c);
      out.push('ENDIF');
    }
    return out as any;
  },
  finalizeTaproot: (script: any, parsed: any, signatures: any) => {
    if (!Array.isArray(signatures))
      throw new TypeError(
        `tr_ord_reveal/finalize: expected signatures array, got ${typeof signatures}`
      );
    if (signatures.length !== 1)
      throw new RangeError(
        `tr_ord_reveal/finalize: expected 1 signature, got ${signatures.length}`
      );
    const [{ pubKey }, sig] = signatures[0];
    if (!P.utils.equalBytes(pubKey, parsed.pubkey)) return;
    // scure-btc-signer appends the Taproot control block after this hook returns [sig, script].
    return [sig, script];
  },
}) as TRet<Coder<OptScript, OutOrdinalRevealType | undefined> & CustomScript>;

/**
 * Create reveal transaction. Inscription created on spending output from this address by
 * revealing taproot script.
 * @param pubkey - x-only taproot public key
 * @param inscriptions - inscription payloads to embed in the reveal script
 * @returns taproot script tree fragment for `@scure/btc-signer`
 * @throws On wrong argument types. {@link TypeError}
 * @throws On wrong argument ranges or values. {@link RangeError}
 * @example
 * Build the taproot script fragment that will reveal the inscription payloads.
 * ```ts
 * import { p2tr_ord_reveal } from 'micro-ordinals';
 * import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * const privKey = randomPrivateKeyBytes();
 * const pubKey = pubSchnorr(privKey);
 * p2tr_ord_reveal(pubKey, [
 *   { tags: { contentType: 'text/plain' }, body: new Uint8Array([1, 2, 3]) },
 * ]);
 * ```
 */
export function p2tr_ord_reveal(
  pubkey: TArg<Bytes>,
  inscriptions: TArg<Inscription[]>
): TRet<{ type: 'tr'; script: Uint8Array }> {
  // `pubkey` becomes the x-only CHECKSIG key inside the reveal tapscript and must stay 32 bytes.
  validateXOnlyPubkey('p2tr_ord_reveal', pubkey);
  return {
    type: 'tr',
    script: P.apply(Script, P.coders.match([OutOrdinalReveal])).encode({
      type: 'tr_ord_reveal',
      pubkey: pubkey as Bytes,
      inscriptions,
    }),
  } as TRet<{ type: 'tr'; script: Uint8Array }>;
}

// Internal methods for tests
export const __test__: any = /* @__PURE__ */ Object.freeze({ TagCoders, TagCoder, parseEnvelopes });
