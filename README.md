# micro-ordinals

Minimal JS library for [ordinals](https://ordinals.com) and inscriptions on top of
[scure-btc-signer](https://github.com/paulmillr/scure-btc-signer).

Use it as a library in your JS code, or run an included CLI tool.
Inscriptions allow uploading random files on BTC blockchain.

**Experimental:** can lead to loss of funds until tested thoroughly.

## Usage

> npm install micro-ordinals

- [Creating inscription](#creating-inscription)
- [TypeScript API](#typescript-api)
- [CLI](#cli)

### Creating inscription

```js
// npm install micro-ordinals @scure/btc-signer @scure/base
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { hex, utf8 } from '@scure/base';

const TESTNET = btc.utils.TEST_NETWORK;
const privKey = hex.decode('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
const pubKey = btc.utils.pubSchnorr(privKey);
const customScripts = [ordinals.OutOrdinalReveal]; // Enable custom scripts outside

// This inscribes on first satoshi of first input (default)
const inscription = {
  tags: {
    contentType: 'application/json', // can be any format (MIME type)
    // ContentEncoding: 'br', // compression: only brotli supported
  },
  body: utf8.decode(JSON.stringify({ some: 1, test: 2, inscription: true, in: 'json' })),
  // One can use previously inscribed js scripts in html
  // utf8.decode(`<html><head></head><body><script src="/content/script_inscription_id"></script>test</html>`)
};

const revealPayment = btc.p2tr(
  undefined, // internalPubKey
  ordinals.p2tr_ord_reveal(pubKey, [inscription]), // TaprootScriptTree
  TESTNET, // mainnet or testnet
  false, // allowUnknownOutputs, safety feature
  customScripts // how to handle custom scripts
);

// We need to send some bitcoins to this address before reveal.
// Also, there should be enough to cover reveal tx fee.
console.log('Address', revealPayment.address); // 'tb1p5mykwcq5ly7y2ctph9r2wfgldq94eccm2t83dd58k785p0zqzwkspyjkp5'

// Be extra careful: it's possible to accidentally send an inscription as a fee.
// Also, rarity is only available with ordinal wallet.
// But you can parse other inscriptions and create a common one using this.
const changeAddr = revealPayment.address; // can be different
const revealAmount = 2000n;
const fee = 500n;

const tx = new btc.Transaction({ customScripts });
tx.addInput({
  ...revealPayment,
  // This is txid of tx with bitcoins we sent (replace)
  txid: '75ddabb27b8845f5247975c8a5ba7c6f336c4570708ebe230caf6db5217ae858',
  index: 0,
  witnessUtxo: { script: revealPayment.script, amount: revealAmount },
});
tx.addOutputAddress(changeAddr, revealAmount - fee, TESTNET);
tx.sign(privKey, undefined, new Uint8Array(32));
tx.finalize();

const txHex = hex.encode(tx.extract());
console.log(txHex); // Hex of reveal tx to broadcast
const tx2 = btc.Transaction.fromRaw(hex.decode(txHex)); // Parsing inscriptions
console.log('parsed', ordinals.parseWitness(tx2.inputs[0].finalScriptWitness));
console.log('vsize', tx2.vsize); // Reveal tx should pay at least this much fee
```

### TypeScript API

```ts
import { Coder } from '@scure/base';
import * as P from 'micro-packed';
import { ScriptType, OptScript, CustomScript } from '@scure/btc-signer';
type Bytes = Uint8Array;
export declare const InscriptionId: P.Coder<string, Bytes>;
type TagRaw = {
    tag: Bytes;
    data: Bytes;
};
declare const TagCoders: {
    pointer: P.CoderType<bigint>;
    contentType: P.CoderType<string>;
    parent: P.Coder<string, Uint8Array>;
    metadata: P.CoderType<any>;
    metaprotocol: P.CoderType<string>;
    contentEncoding: P.CoderType<string>;
    delegate: P.Coder<string, Uint8Array>;
    rune: P.CoderType<bigint>;
    note: P.CoderType<string>;
};
export type Tags = Partial<{
    [K in keyof typeof TagCoders]: P.UnwrapCoder<(typeof TagCoders)[K]>;
}> & {
    unknown?: [Bytes, Bytes][];
};
export type Inscription = { tags: Tags; body: Bytes; cursed?: boolean; };
type OutOrdinalRevealType = { type: 'tr_ord_reveal'; pubkey: Bytes; inscriptions: Inscription[]; };
export declare const OutOrdinalReveal: Coder<OptScript, OutOrdinalRevealType | undefined> & CustomScript;
export declare function parseInscriptions(script: ScriptType, strict?: boolean): Inscription[] | undefined;
/**
 * Parse inscriptions from reveal tx input witness (tx.inputs[0].finalScriptWitness)
 */
export declare function parseWitness(witness: Bytes[]): Inscription[] | undefined;
/**
 * Create reveal transaction. Inscription created on spending output from this address by
 * revealing taproot script.
 */
export declare function p2tr_ord_reveal(pubkey: Bytes, inscriptions: Inscription[]): {
    type: string;
    script: Uint8Array;
};
```

### CLI

> npm install -g micro-ordinals
> ord file.jpg

Usage: ord [--net mainnet|testnet] [--priv key] [--recovery key] [--compress=on|off] [--fee 10.1] [--addr address] <path>

- net: bitcoin network
- priv: taproot private key in WIF format, will be used for reveal transaction
  Don't use your wallet, priv should be a new one.
  We generate a temporary key, if none is provided
- recovery: taproot private key in WIF format, can be used to recover any bitcoins
  sent to inscription address by accident without paying full inscription fee.
- compress: inscriptions compressed with brotli.
  Compatible with explorers. default=on
- fee: bitcoin network fee in satoshis
- addr: address where inscription will be sent after reveal
Important: first sat is always inscribed. Batch inscriptions are not supported.

## Design

There is no network code. It makes package safer, but decreases developer experience.

We can probably fetch fees automatically, but utxo selection would become more complex.
For example if user previously inscribed something or has rare ordinals,
we need access to ordinal node to know that. Also, we don't know anything
about frozen outputs in wallet: it is inside of a wallet only.

Edge cases to keep in mind:

1. user added wrong txid/index or quit application after sending
    - we print temporary private key, user can restart by providing it with '--priv'
    - as long fee/network/path is same, you can restart process
2. user sent less than amount or multiple UTXO.
    - this is actually harder, because any spend will require full inscription fee
    - for this we add `recovery`

## Testing

### Exporers

Use [mempool](https://mempool.space/testnet) and
[ordinalsbot](https://testnet-explorer.ordinalsbot.com).

### Getting testnet coins

There are several faucets:
[uo1](https://bitcoinfaucet.uo1.net/send.php),
[eu](https://coinfaucet.eu/en/btc-testnet/),
[pump](https://cryptopump.info/send.php)

### 3rd-party wallets

To use [sparrow](https://sparrowwallet.com) on mac:

    open /Applications/Sparrow.app --args -n testnet

## License

MIT (c) Paul Miller [(https://paulmillr.com)](https://paulmillr.com), see LICENSE file.
