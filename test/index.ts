import { should } from 'micro-should';

import './cbor.test.ts';
import './cli.test.ts';
import './ordinals.test.ts';

should.runWhen(import.meta.url);
