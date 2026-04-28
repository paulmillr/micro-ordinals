import { describe, should } from '@paulmillr/jsbt/test.js';
import { TEST_NETWORK, WIF } from '@scure/btc-signer';
import { deepStrictEqual, throws } from 'node:assert';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as cli from '../src/cli.ts';

const quiet = <T>(fn: () => T): T => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

describe('micro-ord-cli', () => {
  should('splitArgs', () => {
    deepStrictEqual(cli.splitArgs([]), { args: [], opts: {} });
    deepStrictEqual(cli.splitArgs(['file.js']), { args: ['file.js'], opts: {} });
    deepStrictEqual(cli.splitArgs(['--net', 'testnet', 'file.js']), {
      args: ['file.js'],
      opts: { net: 'testnet' },
    });
    deepStrictEqual(cli.splitArgs(['file.js', '--net', 'testnet']), {
      args: ['file.js'],
      opts: { net: 'testnet' },
    });
    deepStrictEqual(cli.splitArgs(['--priv', 'test', '--net', 'testnet', 'file.js']), {
      args: ['file.js'],
      opts: { priv: 'test', net: 'testnet' },
    });
    deepStrictEqual(cli.splitArgs(['--compress=off', 'file.js']), {
      args: ['file.js'],
      opts: { compress: 'off' },
    });
    deepStrictEqual(cli.splitArgs(['--compress', 'off', '--fee=10.1', 'file.js']), {
      args: ['file.js'],
      opts: { compress: 'off', fee: '10.1' },
    });
    throws(() => cli.splitArgs(['--priv', '--net', 'testnet', 'file.js']));
    throws(() => cli.splitArgs(['file.js', '--net']));
  });

  should('usage text describes fee rate', () => {
    deepStrictEqual(
      cli.__TEST.HELP_TEXT,
      `
- \x1b[1mnet:\x1b[0m bitcoin network
- \x1b[1mpriv:\x1b[0m taproot private key in WIF format, will be used for reveal transaction
  Don't use your wallet, priv should be a new one.
  We generate a temporary key, if none is provided
- \x1b[1mrecovery:\x1b[0m taproot private key in WIF format, can be used to recover any bitcoins
  sent to inscription address by accident without paying full inscription fee.
- \x1b[1mcompress:\x1b[0m inscriptions compressed with brotli.
  Compatible with explorers. default=on
- \x1b[1mfee:\x1b[0m bitcoin network fee in satoshi per vByte
- \x1b[1maddr:\x1b[0m address where inscription will be sent after reveal
\x1b[1mImportant:\x1b[0m first sat is always inscribed. Batch inscriptions are not supported.
`
    );
  });

  should('getKeys', () => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const recovery = Uint8Array.from({ length: 32 }, (_, i) => 32 - i);
    const wif = WIF(TEST_NETWORK);
    deepStrictEqual(
      quiet(() =>
        cli.__TEST.getKeys(TEST_NETWORK, {
          priv: wif.encode(priv),
          recovery: wif.encode(recovery),
        })
      ),
      { priv, recovery }
    );
    const recovered = quiet(() =>
      cli.__TEST.getKeys(TEST_NETWORK, { recovery: wif.encode(recovery) })
    );
    deepStrictEqual(recovered.recovery, recovery);
    deepStrictEqual(recovered.priv.length, 32);
  });

  should('main guard', () => {
    const path = realpathSync(new URL('../src/cli.ts', import.meta.url));
    const url = pathToFileURL(path).href;
    deepStrictEqual(cli.__TEST.isMain(url, ['node', path]), true);
    deepStrictEqual(cli.__TEST.isMain(url, ['node']), false);
    deepStrictEqual(
      cli.__TEST.isMain(url, ['node', realpathSync(new URL('index.ts', import.meta.url))]),
      false
    );
  });
});

should.runWhen(import.meta.url);
