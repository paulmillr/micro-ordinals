import { Coder, hex, utf8 } from "@scure/base";
import * as P from "micro-packed";
import {
  Script,
  ScriptType,
  OptScript,
  CustomScript,
  MAX_SCRIPT_BYTE_LENGTH,
  utils,
} from "@scure/btc-signer";
import { CBOR } from "./cbor.js";

type Bytes = Uint8Array;
const PROTOCOL_ID = /* @__PURE__ */ utf8.decode("ord");

function splitChunks(buf: Bytes): Bytes[] {
  const res = [];
  for (let i = 0; i < buf.length; i += MAX_SCRIPT_BYTE_LENGTH)
    res.push(buf.subarray(i, i + MAX_SCRIPT_BYTE_LENGTH));
  return res;
}

const RawInscriptionId = /* @__PURE__ */ P.tuple([
  P.bytes(32, true),
  P.apply(P.bigint(4, true, false, false), P.coders.numberBigint),
] as const);

export const InscriptionId: P.Coder<string, Bytes> = {
  encode(data: string) {
    const [txId, index] = data.split("i", 2);
    if (`${+index}` !== index)
      throw new Error(`InscriptionId wrong index: ${index}`);
    return RawInscriptionId.encode([hex.decode(txId), +index]);
  },
  decode(data: Bytes) {
    const [txId, index] = RawInscriptionId.decode(data);
    return `${hex.encode(txId)}i${index}`;
  },
};

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

const TagCoders = /* @__PURE__ */ {
  pointer: P.bigint(8, true, false, false), // U64
  contentType: P.string(null),
  parent: InscriptionId,
  metadata: CBOR,
  metaprotocol: P.string(null),
  contentEncoding: P.string(null),
  delegate: InscriptionId,
  rune: P.bigint(16, true, false, false), // U128
  note: P.string(null),
  // unbound: P.bytes(null),
  // nop: P.bytes(null),
};

export type Tags = Partial<{
  [K in keyof typeof TagCoders]: P.UnwrapCoder<(typeof TagCoders)[K]>;
}> & {
  unknown?: [Bytes, Bytes][];
};
// We can't use mappedTag here, because tags can be split in chunks
const TagCoder: P.Coder<TagRaw[], Tags> = {
  encode(from: TagRaw[]): Tags {
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
      if (field === "parent" && tmp[field].length > 1) {
        res[field as TagName] = tmp[field].map((i) =>
          TagCoders.parent.decode(i),
        );
        continue;
      }
      res[field as TagName] = TagCoders[field as TagName].decode(
        utils.concatBytes(...tmp[field]),
      );
    }
    return res as Tags;
  },
  decode(to: Tags): TagRaw[] {
    const res: TagRaw[] = [];
    for (const field in to) {
      if (field === "unknown") continue;
      const tagName = TagCoderInternal.encode(field);
      if (field === "parent" && Array.isArray(to.parent)) {
        for (const p of to.parent)
          res.push({ tag: tagName, data: TagCoders.parent.encode(p) });
        continue;
      }
      const bytes = TagCoders[field as TagName].encode(to[field as TagName]);
      for (const data of splitChunks(bytes)) res.push({ tag: tagName, data });
    }
    if (to.unknown) {
      if (!Array.isArray(to.unknown))
        throw new Error("ordinals/TagCoder: unknown should be array");
      for (const [tag, data] of to.unknown) res.push({ tag, data });
    }
    return res;
  },
};

export type Inscription = { tags: Tags; body: Bytes; cursed?: boolean };
type OutOrdinalRevealType = {
  type: "tr_ord_reveal";
  pubkey: Bytes;
  inscriptions: Inscription[];
};

const parseEnvelopes = (script: ScriptType, pos = 0) => {
  if (!Number.isSafeInteger(pos))
    throw new Error(`parseInscription: wrong pos=${typeof pos}`);
  const envelopes = [];
  // Inscriptions with broken parsing are called 'cursed' (stutter or pushnum)
  let stutter = false;
  main: for (; pos < script.length; pos++) {
    const instr = script[pos];
    if (instr !== 0) continue;
    if (script[pos + 1] !== "IF") {
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
      if (op === "ENDIF") {
        envelopes.push({ start: pos + 3, end: j, pushnum, payload, stutter });
        pos = j;
        break;
      }
      if (op === "1NEGATE") {
        pushnum = true;
        payload.push(new Uint8Array([0x81]));
        continue;
      }
      if (typeof op === "number" && 1 <= op && op <= 16) {
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

// Additional API for parsing inscriptions
export function parseInscriptions(
  script: ScriptType,
  strict = false,
): Inscription[] | undefined {
  if (strict && (!utils.isBytes(script[0]) || script[0].length !== 32)) return;
  if (strict && script[1] !== "CHECKSIG") return;

  const envelopes = parseEnvelopes(script);
  const inscriptions: Inscription[] = [];
  // Check that all inscriptions are sequential inside script
  let pos = 5;
  for (const envelope of envelopes) {
    if (strict && (envelope.stutter || envelope.pushnum)) return;
    if (strict && envelope.start !== pos) return;
    const { payload } = envelope;
    let i = 0;
    const tags: TagRaw[] = [];
    for (; i < payload.length && payload[i] !== 0; i += 2) {
      const tag = payload[i];
      const data = payload[i + 1];
      if (!utils.isBytes(tag))
        throw new Error("parseInscription: non-bytes tag");
      if (!utils.isBytes(data))
        throw new Error("parseInscription: non-bytes tag data");
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
  if (pos - 3 !== script.length) return;
  return inscriptions;
}

/**
 * Parse inscriptions from reveal tx input witness (tx.inputs[0].finalScriptWitness)
 */
export function parseWitness(witness: Bytes[]): Inscription[] | undefined {
  if (witness.length !== 3) throw new Error("Wrong witness");
  // We don't validate other parts of witness here since we want to parse
  // as much stuff as possible. When creating inscription, it is done more strictly
  return parseInscriptions(Script.decode(witness[1]));
}

export const OutOrdinalReveal: Coder<
  OptScript,
  OutOrdinalRevealType | undefined
> &
  CustomScript = {
  encode(from: ScriptType): OutOrdinalRevealType | undefined {
    const res: Partial<OutOrdinalRevealType> = { type: "tr_ord_reveal" };
    try {
      res.inscriptions = parseInscriptions(from, true);
      res.pubkey = from[0] as Bytes;
    } catch (e) {
      return;
    }
    return res as OutOrdinalRevealType;
  },
  decode: (to: OutOrdinalRevealType): OptScript => {
    if (to.type !== "tr_ord_reveal") return;
    const out: ScriptType = [to.pubkey, "CHECKSIG"];
    for (const { tags, body } of to.inscriptions) {
      out.push(0, "IF", PROTOCOL_ID);
      const rawTags = TagCoder.decode(tags);
      for (const tag of rawTags) out.push(tag.tag, tag.data);
      // Body
      out.push(0);
      for (const c of splitChunks(body)) out.push(c);
      out.push("ENDIF");
    }
    return out as any;
  },
  finalizeTaproot: (script: any, parsed: any, signatures: any) => {
    if (signatures.length !== 1)
      throw new Error("tr_ord_reveal/finalize: wrong signatures array");
    const [{ pubKey }, sig] = signatures[0];
    if (!P.utils.equalBytes(pubKey, parsed.pubkey)) return;
    return [sig, script];
  },
};

/**
 * Create reveal transaction. Inscription created on spending output from this address by
 * revealing taproot script.
 */
export function p2tr_ord_reveal(pubkey: Bytes, inscriptions: Inscription[]) {
  return {
    type: "tr_ord_reveal",
    script: P.apply(Script, P.coders.match([OutOrdinalReveal])).encode({
      type: "tr_ord_reveal",
      pubkey,
      inscriptions,
    }),
  };
}

// Internal methods for tests
export const __test__ = { TagCoders, TagCoder, parseEnvelopes };
