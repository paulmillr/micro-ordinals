import { should } from '@paulmillr/jsbt/test.js';

import './cbor.test.ts';
import './cli.test.ts';
import './ordinals.test.ts';

should.runWhen(import.meta.url);
