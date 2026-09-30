import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkerServer } from '../src/contacts/worker-server.js';
import { callWorkerSocket } from '../src/contacts/worker-ipc.js';
import { parseLocalDocument } from '../src/contacts/document-worker.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) {
  if (existsSync(join(dir, 'pid'))) { try { process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')), 'SIGKILL'); } catch {} }
  rmSync(dir, { recursive: true, force: true });
} });
function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'parser-process-')); directories.push(dir);
  const pythonBin = join(dir, 'parser');
  writeFileSync(pythonBin, '#!' + new URL('../python/.venv/bin/python', import.meta.url).pathname + '\n' + body); chmodSync(pythonBin, 0o700);
  return { dir, options: { pythonBin, projectDir: dir, filePath: join(dir, 'input.pdf'),
    fileType: 'pdf' as const, documentId: 'document', limits: {}, sandboxMode: 'test-only' as const } };
}
const sleeper = `import os,time,signal
pid=os.fork()
if pid==0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True: time.sleep(1)
print(pid, file=open(os.path.join(os.path.dirname(__file__), 'pid'), 'w'), flush=True)
while True: time.sleep(1)
`;
async function waitPid(path: string) {
  for (let i=0; i<300 && !existsSync(path); i++) await new Promise(r=>setTimeout(r, 10));
  return Number(readFileSync(path, 'utf8'));
}
async function expectGone(pid: number) {
  for (let i=0; i<100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r=>setTimeout(r, 10));
  }
  throw new Error(`descendant ${pid} survived`);
}
it('cancellation kills the full parser process group', async () => {
  const { dir, options } = fixture(sleeper); const abort = new AbortController();
  const promise = parseLocalDocument(options, abort.signal);
  const rejected = expect(promise).rejects.toMatchObject({code: 'ABORTED'});
  const pid = await waitPid(join(dir, 'pid')); abort.abort(); await rejected; await expectGone(pid);
});
it('wall deadline kills the full parser process group', async () => {
  const { dir, options } = fixture(sleeper);
  const promise = parseLocalDocument({...options, maxRuntimeMs: 500}, new AbortController().signal);
  const rejected = expect(promise).rejects.toMatchObject({code: 'WORKER_TIMEOUT'});
  const pid = await waitPid(join(dir, 'pid')); await rejected; await expectGone(pid);
});
it('caps output without a terminating newline', async () => {
  const { options } = fixture("import sys,time\nsys.stdout.write('a'*300000);sys.stdout.flush();time.sleep(10)\n");
  await expect(parseLocalDocument(options, new AbortController().signal)).rejects.toMatchObject({code:'FRAME_TOO_LARGE'});
});

it('client disconnect cancels a parser and all descendants through the worker socket', async () => {
  const {dir, options} = fixture(sleeper);
  const filePath = join(dir, randomUUID()); writeFileSync(filePath, '%PDF-1.7');
  const socket = join(dir, 'worker.sock');
  const server = createWorkerServer({uploadDirectory: dir, pythonBin: options.pythonBin, sandboxMode: 'test-only'});
  server.listen(socket); await new Promise(resolve => server.once('listening', resolve));
  const abort = new AbortController();
  try {
    const promise = callWorkerSocket(socket, '/parse', {filePath, fileType: 'pdf', limits: {}, documentId: 'test'}, abort.signal);
    const rejected = expect(promise).rejects.toThrow('ABORTED');
    const pid = await waitPid(join(dir, 'pid')); abort.abort(); await rejected; await expectGone(pid);
  } finally { abort.abort(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('bounds total wire output including repeated metadata', async () => {
  const {options} = fixture(`import sys,json,time
request=json.loads(sys.stdin.readline())
for i in range(200):
 print(json.dumps(dict(version=1,request_id=request['request_id'],kind='block',block=dict(block_id=str(i),text='x',source_ref='a'*200000))),flush=True)
time.sleep(10)
`);
  await expect(parseLocalDocument(options, new AbortController().signal)).rejects.toMatchObject({code:'DOCUMENT_OUTPUT_TOO_LARGE'});
});

it('removes scratch even after the parser removes directory permissions', async () => {
  const {options} = fixture(`import os,sys,json
request=json.loads(sys.stdin.readline())
scratch=os.environ['TMPDIR']
nested=os.path.join(scratch,'locked')
os.mkdir(nested)
open(os.path.join(nested,'data'),'w').write('raw')
os.chmod(nested,0)
os.chmod(scratch,0)
print(json.dumps(dict(version=1,request_id=request['request_id'],kind='block',block=dict(block_id='1',text=scratch))),flush=True)
print(json.dumps(dict(version=1,request_id=request['request_id'],kind='done',block_count=1,warning_codes=[])),flush=True)
`);
  const blocks = await parseLocalDocument(options, new AbortController().signal);
  expect(existsSync(blocks[0]!.text)).toBe(false);
});

it('removes a scratch tree deeper than PATH_MAX without crashing the supervisor', async () => {
  const {options} = fixture(`import os,sys,json
request=json.loads(sys.stdin.readline())
scratch=os.environ['TMPDIR']
sentinel=os.path.join(os.path.dirname(__file__),'sentinel')
open(sentinel,'w').write('do not touch')
os.chmod(sentinel,0o400)
os.symlink(sentinel,os.path.join(scratch,'outside'))
os.chdir(scratch)
for _ in range(600):
 os.mkdir('abcdefgh');os.chdir('abcdefgh')
open('raw','w').write('private input')
print(json.dumps(dict(version=1,request_id=request['request_id'],kind='block',block=dict(block_id='1',text=scratch))),flush=True)
print(json.dumps(dict(version=1,request_id=request['request_id'],kind='done',block_count=1,warning_codes=[])),flush=True)
`);
  const blocks = await parseLocalDocument(options, new AbortController().signal);
  expect(existsSync(blocks[0]!.text)).toBe(false);
  expect(readFileSync(join(options.projectDir, 'sentinel'), 'utf8')).toBe('do not touch');
  expect(statSync(join(options.projectDir, 'sentinel')).mode & 0o777).toBe(0o400);
});

it('reports cleanup helper failures without an uncaught close callback error', async () => {
  const {options} = fixture(`import os,sys,json
request=json.loads(sys.stdin.readline())
os.rmdir(os.environ['TMPDIR'])
print(json.dumps(dict(version=1,request_id=request['request_id'],kind='done',block_count=0,warning_codes=[])),flush=True)
`);
  await expect(parseLocalDocument(options, new AbortController().signal)).rejects.toMatchObject({code:'SCRATCH_CLEANUP_FAILED'});
});
