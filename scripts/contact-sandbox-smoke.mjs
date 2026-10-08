/** Remote Linux production-image gate. Run as the worker's unprivileged user. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnParser } from '/app/dist/contacts/parser-process.js';
import { startWorker } from '/app/dist/contacts/worker-server.js';
import { callWorkerSocket } from '/app/dist/contacts/worker-ipc.js';

assert.equal(process.platform, 'linux', 'Linux kernel required; this gate must never skip');
assert.notEqual(process.getuid(), 0, 'Run unprivileged so process limits apply');
// Check the actual container, as well as Compose's declarative configuration.
const status = readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m, 'Capabilities must remain dropped');
assert.match(status, /^NoNewPrivs:\s+1$/m, 'no-new-privileges must remain enabled');
const rootMount = readFileSync('/proc/mounts', 'utf8').split('\n').find(line => line.split(' ')[1] === '/');
assert.ok(rootMount?.split(' ')[3].split(',').includes('ro'), 'Container root must remain read-only');
assert.deepEqual(Object.keys(networkInterfaces()), ['lo'], 'Worker must have no network interface');
assert.equal(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), String(4 * 1024**3));
assert.equal(readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), '64');
const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/).map(Number);
assert.equal(quota / period, 2, 'Worker CPU quota must remain two cores');
assert.equal(existsSync('/app/.env'), false, 'Worker image must contain no service .env');
for (const name of ['ARK_CREDENTIAL', 'ARK_EMBEDDING_CREDENTIAL', 'QCC_SECRET_KEY']) {
  assert.equal(process.env[name], undefined, 'Worker must receive no service credentials');
}
const pythonBin = '/opt/contact-worker/.venv/bin/python';
const result = spawnSync(pythonBin, ['/usr/local/bin/contact-sandbox-tests.py', '-v'], {
  env: { PATH: '/usr/bin:/bin', CONTACT_WORKER_PYTHON_ROOT: '/app/python', PYTHONPATH: '/app/python' },
  encoding: 'utf8', timeout: 60_000,
});
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
assert.equal(result.status, 0, 'Real Landlock/seccomp/resource probes failed');
assert.ok(!result.stderr.includes('skipped'), 'Kernel probes may not skip');

const directory = mkdtempSync(join(tmpdir(), 'sandbox-smoke-'));
try {
  const source = join(directory, randomUUID());
  copyFileSync('/usr/local/share/contact-sandbox/synthetic-resume.pdf', source);
  const socket = join(directory, 'worker.sock');
  const server = await startWorker({socket, uploadDirectory: directory, pythonBin});
  try {
    assert.deepEqual(await callWorkerSocket(socket, '/healthz', {}), {ready: true});
    const payload = {filePath: source, fileType: 'pdf', limits: {}, documentId: 'sandbox-smoke'};
    await callWorkerSocket(socket, '/preflight', payload);
    const blocks = await callWorkerSocket(socket, '/parse', payload);
    assert.ok(blocks.length > 0 && blocks.some(block => block.page === 1), 'Real hardened PDF failed');
  } finally { await new Promise(resolve => server.close(resolve)); }

  // Exercise the production supervisor with hostile code sealed by the same sandbox.
  // The fixture is trusted test setup; no production endpoint selects arbitrary code.
  for (const failure of ['cpu', 'memory', 'deadline', 'cancel', 'success', 'deep-tree']) {
    const sourceMode = statSync(source).mode;
    const projectDir = join(directory, `probe-${failure}`);
    mkdirSync(join(projectDir, 'contact_worker'), {recursive: true});
    writeFileSync(join(projectDir, 'contact_worker', '__init__.py'), '');
    const executable = join(projectDir, 'contact_worker', 'launcher.py');
    writeFileSync(executable, `import os,sys,time,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('boundary','/app/python/contact_worker/sandbox.py')
boundary=importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
boundary.enter(Path(sys.argv[3]),Path(sys.argv[4]),cpu_seconds=1,memory_bytes=128*1024**2)
pid=os.fork()
if pid==0:
    while True: time.sleep(1)
print(pid,flush=True)
${failure === 'deep-tree' ? "print(sys.argv[4],flush=True)\nos.symlink(sys.argv[3],'outside')\nfor _ in range(600):\n os.mkdir('abcdefgh');os.chdir('abcdefgh')\nopen('raw','w').write('private input')\nos.chmod('.',0)\nsys.exit(0)" : failure === 'cpu' ? 'while True: pass' : failure === 'memory' ? 'bytearray(512*1024**2)' : failure === 'success' ? 'sys.exit(0)' : 'while True: time.sleep(1)'}
`);
    let kill; let timedOut = false;
    const spawned = spawnParser({pythonBin, projectDir, filePath: source,
      fileType: 'pdf', limits: {}, maxRuntimeMs: failure === 'deadline' ? 500 : 5000}, 'parse', 'probe',
    () => { timedOut = true; kill(); });
    kill = spawned.kill;
    let output = '';
    spawned.child.stdout.on('data', chunk => { output += chunk; if (failure === 'cancel') kill(); });
    spawned.child.stdin.end();
    const ended = await new Promise(resolve => spawned.child.once('close', (code, signal) => resolve({code, signal})));
    assert.equal(await spawned.cleanup, undefined, `${failure}: scratch cleanup failed`);
    const lines = output.trim().split('\n');
    const descendant = Number(lines[0]);
    if (failure === 'deep-tree') {
      assert.ok(lines[1]?.startsWith('/tmp/contact-parser-'));
      assert.equal(existsSync(lines[1]), false, 'Deep scratch tree survived cleanup');
      assert.equal(ended.code, 0, 'Deep-tree creation failed');
      assert.equal(statSync(source).mode, sourceMode, 'Cleanup followed an input symlink');
    }
    assert.ok(Number.isSafeInteger(descendant) && descendant > 1, `${failure}: fixture never forked`);
    if (failure === 'deadline') assert.ok(timedOut);
    else assert.ok(!timedOut, `${failure}: expected outcome was replaced by deadline`);
    if (failure === 'cpu') assert.equal(ended.signal, 'SIGKILL');
    if (failure === 'memory') assert.notEqual(ended.code, 0);
    for (let i=0; i<100; i++) {
      try {
        // Zombies cannot execute and are reaped by the container init process.
        const state = readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1][0];
        if (state === 'Z') break;
      } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      assert.ok(i < 99, `${failure}: descendant survived`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
} finally { rmSync(directory, {recursive: true, force: true}); }
console.log('contact sandbox smoke: real kernel denials, hardened PDF, and descendant teardown passed');
