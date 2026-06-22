/** Global test setup. Resets the coreRegistry default engine before each test so
 *  the "a second createEngine() throws" rule doesn't leak the default across the
 *  many tests (and test files) that call createEngine(). */

import { beforeEach } from 'bun:test';
import { coreRegistry } from '../src';

beforeEach(() => {
  if (coreRegistry.has()) coreRegistry.clear();
});
