import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/database.js';
import { ProfileRepository } from '../src/db/profile-repository.js';
import { AssessmentRepository } from '../src/db/assessment-repository.js';
import { PROFILE, CODE, AT } from './fixtures/company-context.js';

it('finds saved profiles in batches even after fresh lookup expires', () => {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  try {
    const repo = new ProfileRepository(db); repo.upsert(PROFILE);
    expect(repo.findByCreditCodes([CODE])).toEqual([PROFILE]);
    expect(repo.findByNormalizedNames(['测试装备有限公司'])).toEqual([PROFILE]);
    expect(repo.findByCreditCodes([])).toEqual([]);
    expect(repo.findFreshByCreditCode(CODE, new Date('2027-01-01T00:00:00.000Z'), 30)).toBeNull();
  } finally { db.close(); }
});

it('summarizes completed reports without returning report bodies or mixing companies', () => {
  const db = initializeDatabase(new DatabaseSync(':memory:'));
  try {
    const code2 = 'CODE2';
    const insert = db.prepare(`INSERT INTO assessments
      (assessment_id,cache_key,requested_by,legal_name,credit_code,status,report_markdown,overall_opportunity,collected_at,created_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run('a1',CODE,'test','A',CODE,'completed','PRIVATE BODY','high',AT,AT,AT);
    insert.run('a2',CODE,'test','A',CODE,'completed','PRIVATE BODY 2','low',AT,AT,AT);
    insert.run('f1',CODE,'test','A',CODE,'failed','failed body',null,null,AT,null);
    insert.run('b1',code2,'test','B',code2,'completed','OTHER BODY','medium',AT,AT,AT);
    const repo = new AssessmentRepository(db);
    const summaries = repo.summariesByCreditCodes([CODE, code2, 'missing']);
    expect(summaries.get(CODE)).toMatchObject({ count: 2, latest: { assessment_id: 'a2' } });
    expect(summaries.get(code2)).toMatchObject({ count: 1, latest: { assessment_id: 'b1' } });
    expect(summaries.get('missing')).toEqual({ count: 0, latest: null });
    expect(JSON.stringify(summaries.get(CODE))).not.toContain('PRIVATE BODY');
    expect(repo.listCompleted(CODE,0,1)).toMatchObject({ total: 2, items: [{ assessment_id: 'a2' }], next_offset: 1 });
  } finally { db.close(); }
});
