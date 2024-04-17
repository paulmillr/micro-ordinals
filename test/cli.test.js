import { describe, should } from 'micro-should';
import { deepStrictEqual, throws } from 'node:assert';
import * as cli from '../lib/esm/cli.js';

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
    throws(() => cli.splitArgs(['--priv', '--net', 'testnet', 'file.js']));
    throws(() => cli.splitArgs(['file.js', '--net']));
  });
});

should('Basic', () => {
  console.log('TEST?');
});

// ESM is broken.
import url from 'url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  should.run();
}
