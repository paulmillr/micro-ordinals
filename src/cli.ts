#!/usr/bin/env node
import { constants as zlibc, brotliCompressSync } from 'node:zlib';
import { extname } from 'node:path';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';

// @ts-ignore
import Input from 'enquirer/lib/prompts/input.js';
// @ts-ignore
import Select from 'enquirer/lib/prompts/select.js';
import { hex } from '@scure/base';
import {
  Address,
  Decimal,
  Transaction,
  WIF,
  p2tr,
  NETWORK,
  TEST_NETWORK,
  utils,
} from '@scure/btc-signer';
import { Inscription, OutOrdinalReveal, p2tr_ord_reveal } from './index.js';
/*

*/

const { BROTLI_MODE_GENERIC: B_GENR, BROTLI_MODE_TEXT: B_TEXT, BROTLI_MODE_FONT } = zlibc;
// Max script limit.
// Bitcoin core node won't relay transaction with bigger limit, even if they possible.
// https://github.com/bitcoin/bitcoin/blob/d908877c4774c2456eed09167a5f382758e4a8a6/src/policy/policy.h#L26-L27
const MAX_STANDARD_TX_WEIGHT = 400000; // 4 * 100kvb
const DUST_RELAY_TX_FEE = 3000n; // won't relay if less than this in fees?
const customScripts = [OutOrdinalReveal];
const ZERO_32B = '00'.repeat(32);

// Utils
type Opts = Record<string, string>;
export function splitArgs(args: string[]): { args: string[]; opts: Opts } {
  const _args: string[] = [];
  const opts: Opts = {};
  for (let i = 0; i < args.length; i++) {
    const cur = args[i];
    if (cur.startsWith('--')) {
      if (i + 1 >= args.length) throw new Error(`arguments: no value for ${cur}`);
      const next = args[++i];
      if (next.startsWith('--')) throw new Error(`arguments: no value for ${cur}, got ${next}`);
      opts[cur.slice(2)] = next;
      continue;
    }
    _args.push(cur);
  }
  return { args: _args, opts };
}

const validateFloat = (s: string) => {
  const n = Number.parseFloat(s);
  const matches = n.toString() === s && Number.isFinite(n) && n > 0;
  return matches || `Number must be greater than zero`;
};

const validateTxid = (s: string) => {
  try {
    const txid = hex.decode(s);
    if (txid.length !== 32) return `wrong length ${txid.length}, expected 32 bytes`;
    return true;
  } catch (e) {
    return `${e}`;
  }
};

const validateIndex = (s: string) => {
  const n = Number.parseInt(s);
  // Index is U32LE
  const matches = s === `${n}` && Number.isInteger(n) && 0 <= n && n < 2 ** 32;
  return matches || `Number must be between 0 and ${2 ** 32}`;
};

const validateAmount = (s: string) => {
  try {
    const n = Decimal.decode(s);
    if (n <= 0) return `amount should be bigger than zero`;
    return true;
  } catch (e) {
    return `${e}`;
  }
};

// /Utils

// UI
// const underline = '\x1b[4m';
const bold = '\x1b[1m';
// const gray = '\x1b[90m';
const reset = '\x1b[0m';
const red = '\x1b[31m';
const green = '\x1b[32m';
// const yellow = '\x1b[33m';
const magenta = '\x1b[35m';

const HELP_TEXT = `
- ${bold}net:${reset} bitcoin network
- ${bold}priv:${reset} taproot private key in WIF format, will be used for reveal transaction
  Don't use your wallet, priv should be a new one.
  We generate a temporary key, if none is provided
- ${bold}recovery:${reset} taproot private key in WIF format, can be used to recover any bitcoins
  sent to inscription address by accident without paying full inscription fee.
- ${bold}compress:${reset} inscriptions compressed with brotli.
  Compatible with explorers. default=on
- ${bold}fee:${reset} bitcoin network fee in satoshis
- ${bold}addr:${reset} address where inscription will be sent after reveal
${bold}Important:${reset} first sat is always inscribed. Batch inscriptions are not supported.
`;

type InputValidate = (input: string) => boolean | string | Promise<boolean | string>;

export const select = async (message: string, choices: string[]) => {
  try {
    return await new Select({ message, choices }).run();
  } catch (e) {
    process.exit(); // ctrl+c
  }
};

export async function input(message: string, validate?: InputValidate) {
  let opts: { message: string; validate?: InputValidate } = { message };
  if (validate) opts.validate = validate;
  try {
    return await new Input(opts).run();
  } catch (e) {
    process.exit(); // ctrl+c
  }
}

declare const navigator: any;
const defaultLang = typeof navigator === 'object' ? navigator.language : undefined;
const bfmt = new Intl.NumberFormat(defaultLang, { style: 'unit', unit: 'byte' });

const formatBytes = (n: number) => `${magenta}${bfmt.format(n)}${reset}`;
const formatSatoshi = (n: bigint) =>
  `${magenta}${n}${reset} satoshi (${magenta}${Decimal.encode(n)}${reset} BTC)`;
const formatAddress = (s: string) => `${green}${s}${reset}`;
// /UI

// We support MIME types, supported by ordinals explorer.
// Other MIME types can be allowed, but won't be displayed there.
// Important: .txt file can actually be .jpg, etc.
// prettier-ignore
const contentTypeTable: [string, number, string[]][] = [
  ["application/cbor",            B_GENR, [".cbor"]],
  ["application/json",            B_TEXT, [".json"]],
  ["application/octet-stream",    B_GENR, [".bin"]],
  ["application/pdf",             B_GENR, [".pdf"]],
  ["application/pgp-signature",   B_TEXT, [".asc"]],
  ["application/protobuf",        B_GENR, [".binpb"]],
  ["application/yaml",            B_TEXT, [".yaml", ".yml"]],
  ["audio/flac",                  B_GENR, [".flac"]],
  ["audio/mpeg",                  B_GENR, [".mp3"]],
  ["audio/wav",                   B_GENR, [".wav"]],
  ["font/otf",                    B_GENR, [".otf"]],
  ["font/ttf",                    B_GENR, [".ttf"]],
  ["font/woff",                   B_GENR, [".woff"]],
  ["font/woff2",                  BROTLI_MODE_FONT,    [".woff2"]],
  ["image/apng",                  B_GENR, [".apng"]],
  ["image/avif",                  B_GENR, [".avif"]],
  ["image/gif",                   B_GENR, [".gif"]],
  ["image/jpeg",                  B_GENR, [".jpg", ".jpeg"]],
  ["image/png",                   B_GENR, [".png"]],
  ["image/svg+xml",               B_TEXT, [".svg"]],
  ["image/webp",                  B_GENR, [".webp"]],
  ["model/gltf+json",             B_TEXT, [".gltf"]],
  ["model/gltf-binary",           B_GENR, [".glb"]],
  ["model/stl",                   B_GENR, [".stl"]],
  ["text/css",                    B_TEXT, [".css"]],
  ["text/html;charset=utf-8",     B_TEXT, [".html"]],
  ["text/javascript",             B_TEXT, [".js"]],
  ["text/markdown;charset=utf-8", B_TEXT, [".md"]],
  ["text/plain;charset=utf-8",    B_TEXT, [".txt"]],
  ["text/x-python",               B_TEXT, [".py"]],
  ["video/mp4",                   B_GENR, [".mp4"]],
  ["video/webm",                  B_GENR, [".webm"]],
];

// Some formats have multiple extensions
const contentType: Map<string, [string, number]> = new Map();
for (const [type, brotliMode, exts] of contentTypeTable) {
  for (const ext of exts) contentType.set(ext, [type, brotliMode]);
}

const NETWORKS: Record<string, typeof NETWORK & { name: string }> = {
  mainnet: { ...NETWORK, name: `${red}mainnet${reset}` },
  testnet: { ...TEST_NETWORK, name: `testnet` },
};
type NET = (typeof NETWORKS)[keyof typeof NETWORKS];

const usage = (err?: Error | string) => {
  if (err) console.error(`${red}ERROR${reset}: ${err}`);
  console.log(
    `Usage: ${green}ord-cli${reset} [--net ${Object.keys(NETWORKS).join(
      '|',
    )}] [--priv key] [--recovery key] [--compress=on|off] [--fee 10.1] [--addr address] <path>`,
  );
  console.log(HELP_TEXT);
  process.exit();
};

async function getNetwork(opts: Opts) {
  if (!opts.net) opts.net = await select('Network', ['testnet', 'mainnet']);
  const NET = NETWORKS[opts.net];
  if (typeof opts.net !== 'string' || !NET)
    return usage(`wrong network ${opts.net}. Expected: ${Object.keys(NETWORKS).join(', ')}`);
  console.log(`${bold}Network:${reset} ${NET.name}`);
  return NET;
}

function getKeys(net: NET, opts: Opts) {
  const KEYS: Record<string, string> = { priv: 'Temporary', recovery: 'Recovery' };
  const res: Record<string, Uint8Array> = {};
  for (const name in KEYS) {
    // We can probably can do taproot tweak,
    // but if user provided non-taproot key there would be an error?
    // For example user can accidentally provide key for
    if (opts[name]) res[name] = WIF(net).decode(opts.priv);
    else {
      res[name] = utils.randomPrivateKeyBytes();
      console.log(`${KEYS[name]} private key: ${red}${WIF(net).encode(res[name])}${reset}`);
    }
    if (res[name].length !== 32) {
      return usage(
        `wrong ${KEYS[name].toLowerCase()} private key, expected 32-bytes, got ${res[name].length}`,
      );
    }
  }
  console.log(
    `${bold}Important:${reset} if there is an issue with reveal transaction, you will need these keys to refund sent coins`,
  );
  return res as { priv: Uint8Array; recovery: Uint8Array };
}

function getInscription(filePath: string, opts: Opts) {
  const stat = lstatSync(filePath);
  if (!stat.isFile()) return usage(`path is not file "${filePath}"`);
  const ext = extname(filePath).toLowerCase();
  const type = contentType.get(ext);
  if (!type) throw new Error(`unknown extension "${ext}"`);
  const [mime, brotliMode] = type;
  const info: string[] = [];
  info.push(`mime=${mime}`);
  let data = Uint8Array.from(readFileSync(filePath, null));
  let inscription: Inscription = { tags: { contentType: mime }, body: data };
  info.push(`size=${formatBytes(data.length)}`);
  if (!opts.compress || opts.compress !== 'off') {
    const compressed = brotliCompressSync(data, {
      params: {
        [zlibc.BROTLI_PARAM_MODE]: brotliMode,
        [zlibc.BROTLI_PARAM_QUALITY]: zlibc.BROTLI_MAX_QUALITY,
        [zlibc.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    });
    // Very small files can take more space after compression
    if (data.length > compressed.length) {
      data = compressed;
      info.push(`compressed_size=${formatBytes(data.length)}`);
      inscription = { tags: { contentType: mime, contentEncoding: 'br' }, body: data };
    }
  } else info.push(`${red}uncompressed${reset}`); // notify user that compression disabled
  if (data.length > MAX_STANDARD_TX_WEIGHT)
    return usage(`File is too big ${data.length}. Limit ${MAX_STANDARD_TX_WEIGHT}`);
  console.log(`${bold}File:${reset} ${filePath} (${info.join(', ')})`);
  return inscription;
}

async function getFee(opts: Opts) {
  let fee = opts.fee;
  if (!fee) fee = await input(`Network fee (in satoshi)`, validateFloat);
  if (validateFloat(fee) !== true) return usage(`wrong fee=${fee}`);
  return parseFloat(fee);
}

async function getAddr(net: NET, opts: Opts) {
  let address = opts.addr;
  const validate = (s: string) => {
    try {
      Address(net).decode(s);
      return true;
    } catch (e) {
      return `${e}`;
    }
  };
  if (!address)
    address = await input('Change address (where inscription will be sent on reveal)', validate);
  if (validate(address) !== true) return usage(`wrong address=${address}`);
  return address;
}

function getPayment(privKey: Uint8Array, recovery: Uint8Array, inscription: Inscription, net: NET) {
  const pubKey = utils.pubSchnorr(privKey);
  const recoveryPub = utils.pubSchnorr(recovery);
  return p2tr(recoveryPub, p2tr_ord_reveal(pubKey, [inscription]), net, false, customScripts);
}

function getTransaction(
  privKey: Uint8Array,
  addr: string,
  payment: ReturnType<typeof getPayment>,
  net: NET,
  txid: string,
  index: number,
  amount: bigint,
  fee: bigint,
) {
  const tx = new Transaction({ customScripts });
  tx.addInput({
    ...payment,
    txid,
    index,
    witnessUtxo: { script: payment.script, amount },
  });
  tx.addOutputAddress(addr, amount - fee, net);
  tx.sign(privKey, undefined, new Uint8Array(32));
  tx.finalize();
  return tx;
}

async function main() {
  try {
    const argv = process.argv;
    // @ts-ignore
    if (import.meta.url !== `file://${realpathSync(argv[1])}`) return; // ESM is broken.
    if (argv.length < 3) return usage('Wrong argument count'); // node script file
    const { args, opts } = splitArgs(argv.slice(2));
    if (args.length !== 1) return usage(`only single file supported, got ${args.length}`);
    const net = await getNetwork(opts);
    const inscription = getInscription(args[0], opts);
    const { priv, recovery } = getKeys(net, opts);
    const fee = await getFee(opts);
    const addr = await getAddr(net, opts);
    // Actual logic
    const payment = getPayment(priv, recovery, inscription, net);
    // dummy tx to estimate fees and tx size
    const dummyTx = getTransaction(priv, addr, payment, net, ZERO_32B, 0, DUST_RELAY_TX_FEE, 1n);
    if (dummyTx.weight >= MAX_STANDARD_TX_WEIGHT) {
      return usage(
        `File is too big: reveal transaction weight (${dummyTx.weight}) is higher than limit (${MAX_STANDARD_TX_WEIGHT})`,
      );
    }
    const txFee = BigInt(Math.floor(dummyTx.vsize * fee));
    console.log(`${bold}Fee:${reset} ${formatSatoshi(txFee)}`);
    // If output of reveal tx considered dust, it would be hard to spend later,
    // real limit is probably lower, but we take bigger value to be sure.
    // Making UTXO inscription dust can probably prevent spending as fees,
    // but also will prevent moving to different address.
    const minAmount = DUST_RELAY_TX_FEE + txFee;
    console.log(
      `Created. Please send at least ${formatSatoshi(minAmount)} to ${formatAddress(
        payment.address!,
      )}`,
    );
    // Ask for UTXO
    console.log('Please enter UTXO information for transaction you sent:');
    // These fields cannot be known before we send tx,
    // and to send tx user needs an address of inscription
    const txid = await input('Txid', validateTxid);
    const index = Number.parseInt(await input('Index', validateIndex));
    const amount = Decimal.decode(await input('Amount', validateAmount));
    // Real reveal transaction
    const tx = getTransaction(priv, addr, payment, net, txid, index, amount, txFee);
    console.log('Reveal transaction created.');
    console.log(`${bold}Txid:${reset} ${tx.id}`);
    console.log(`${bold}Tx:${reset}`);
    console.log(hex.encode(tx.extract()));
    console.log(
      `Please broadcast this transaction to reveal inscription and transfer to your address (${formatAddress(
        addr,
      )})`,
    );
    console.log(
      `${bold}Important:${reset} please freeze this UTXO in your wallet when received to avoid sending inscription as fees for other transactions.`,
    );
  } catch (e) {
    return usage(e as Error);
  }
}

main();
