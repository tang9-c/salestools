import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error standalone Node migration utility
import { inspectTokens, resolveDuplicates } from '../tools/token-migration.mjs';
const dirs: string[]=[];
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'token-migration-'));dirs.push(dir);
  const path=join(dir,'source.sqlite'),db=new DatabaseSync(path);
  db.exec('CREATE TABLE tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL)');
  for(const [hash,user] of [['a','sales'],['b','sales'],['c','other']])
    db.prepare('INSERT INTO tokens VALUES(?,?,1,?)').run(hash.repeat(64),user,'2026-10-16T00:00:00.000Z');
  db.close();return {path,backup:join(dir,'backup.sqlite')};
}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
it('preflights without exposing hashes or changing rows',async()=>{
  const f=await fixture(),report=inspectTokens(f.path);
  expect(report.duplicateUsers).toEqual(['sales']);expect(report.records).toHaveLength(3);
  expect(JSON.stringify(report)).not.toContain('aaaa');
  expect(inspectTokens(f.path)).toEqual(report);
});
it('backs up all records before keeping only explicitly selected tokens',async()=>{
  const f=await fixture();await resolveDuplicates(f.path,[{userId:'sales',recordId:2}],f.backup);
  expect(inspectTokens(f.path).duplicateUsers).toEqual([]);
  expect(inspectTokens(f.path).records.map((r:{recordId:number})=>r.recordId)).toEqual([2,3]);
  expect(inspectTokens(f.backup).records).toHaveLength(3);
  expect((await stat(f.backup)).mode&0o777).toBe(0o600);
  await expect(resolveDuplicates(f.path,[],f.backup)).rejects.toThrow();
});
it('rejects missing or wrong selections without deleting any token',async()=>{
  const f=await fixture();
  await expect(resolveDuplicates(f.path,[],f.backup)).rejects.toThrow();
  await expect(resolveDuplicates(f.path,[{userId:'sales',recordId:3}],f.backup)).rejects.toThrow();
  expect(inspectTokens(f.path).records).toHaveLength(3);
});
