// A stand-in for server/chain/index/worker.js that misbehaves on request: answers 'ok' jobs,
// exits the process on 'die', throws outside the handler on 'throw'. For the Pool's own test.
import { parentPort } from 'node:worker_threads';
// `node --test` collects every .js under test/, this one included: outside a worker it does nothing
if (parentPort) parentPort.on('message', (job) => {
  if (job.type === 'die') process.exit(3);
  if (job.type === 'throw') { setImmediate(() => { throw new Error('worker blew up'); }); return; }
  parentPort.postMessage({ type: 'done', job });
});
