#!/usr/bin/env node
import { DatabaseSync, backup } from 'node:sqlite';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function records(db) {
  return db.prepare('SELECT rowid AS recordId,user_id AS userId,enabled,created_at AS createdAt FROM tokens ORDER BY rowid').all();
}
function duplicates(rows) {
  const counts=new Map();for(const row of rows) counts.set(row.userId,(counts.get(row.userId)??0)+1);
  return [...counts].filter(([,count])=>count>1).map(([user])=>user);
}
export function inspectTokens(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {const rows=records(db);return {records:rows,duplicateUsers:duplicates(rows)};} finally {db.close();}
}

/** Offline maintenance only. Backup is exclusive and never overwrites an existing file. */
export async function resolveDuplicates(path,selections,backupPath) {
  if(resolve(path)===resolve(backupPath)) throw new Error('TOKEN_BACKUP_PATH_INVALID');
  const source=await open(path,'r+');await source.close();
  const db=new DatabaseSync(path);
  try {
    const rows=records(db),users=duplicates(rows);
    if(!Array.isArray(selections) || selections.length!==users.length || new Set(selections.map(s=>s?.userId)).size!==users.length)
      throw new Error('TOKEN_MIGRATION_SELECTION_REQUIRED');
    for(const selection of selections) {
      if(!selection || Object.keys(selection).sort().join(',')!=='recordId,userId'
        || !users.includes(selection.userId) || !Number.isSafeInteger(selection.recordId)
        || !rows.some(row=>row.userId===selection.userId && row.recordId===selection.recordId))
        throw new Error('TOKEN_MIGRATION_SELECTION_INVALID');
    }
    const snapshot=JSON.stringify(db.prepare('SELECT rowid,* FROM tokens ORDER BY rowid').all());
    const file=await open(backupPath,'wx',0o600);await file.chmod(0o600);await file.close();
    await backup(db,backupPath);
    db.exec('BEGIN IMMEDIATE');
    try {
      if(JSON.stringify(db.prepare('SELECT rowid,* FROM tokens ORDER BY rowid').all())!==snapshot)
        throw new Error('TOKEN_MIGRATION_DATABASE_CHANGED');
      for(const selection of selections)
        db.prepare('DELETE FROM tokens WHERE user_id=? AND rowid<>?').run(selection.userId,selection.recordId);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    return {backupPath:resolve(backupPath),kept:selections,records:records(db)};
  } finally {db.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action,...args]=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i+=2) {
      if(!['--db','--selections','--backup'].includes(args[i]) || options[args[i]]!==undefined || !args[i+1]) throw new Error('TOKEN_MIGRATION_ARGUMENTS');
      options[args[i]]=args[i+1];
    }
    let result;
    if(action==='preflight' && options['--db'] && Object.keys(options).length===1) result=inspectTokens(options['--db']);
    else if(action==='resolve' && Object.keys(options).length===3)
      result=await resolveDuplicates(options['--db'],JSON.parse(await readFile(options['--selections'],'utf8')),options['--backup']);
    else throw new Error('TOKEN_MIGRATION_ARGUMENTS');
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch(error) {
    const code=error instanceof Error ? error.message : '';
    process.stderr.write((/^TOKEN_[A-Z_]+$/.test(code)?code:'TOKEN_MIGRATION_FAILED')+'\n');process.exitCode=1;
  }
}
