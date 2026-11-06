/**
 * Regression probe: importing server.ts must NOT spawn the egress pool.
 * A test suite imports this module for `startServer()`; booting the pool there
 * used to leak 4 Xray children and hang the test process.
 */
import '../src/backend/server';
import { egressPool } from '../src/backend/vpn/egress-pool';

setTimeout(() => {
  const slots = egressPool.getSlots().length;
  console.log(`import probe: pool slots = ${slots}`);
  if (slots !== 0) {
    console.error('FAIL: importing server.ts started the pool');
    process.exit(1);
  }
  console.log('PASS: import is side-effect free');
  process.exit(0);
}, 2500);
