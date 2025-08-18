import { describe, should } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import * as cli from '../src/cli.ts';

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

should.runWhen(import.meta.url);
