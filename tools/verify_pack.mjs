import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {parseEnv} from 'node:util'
import {loadBundle,importRecords} from '../restore.mjs'
const [target,bundle]=process.argv.slice(2)
if(!target||!bundle)throw new Error('node tools/verify_pack.mjs INSTALLED_PROGRAM EXTRACTED_PACK')
const {default:pg}=await import(createRequire(path.resolve(target,'web/package.json')).resolve('pg'))
const config=parseEnv(await fs.readFile(path.join(target,'web/.env.local'),'utf8'))
const url=new URL(config.DATABASE_URL)
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname))
const db=new pg.Client({connectionString:url.href}),schema='research_pack_test_'+process.pid
const {records,manifest}=await loadBundle(bundle)
await db.connect()
try{
 await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`)
 const inserted=await importRecords(db,records)
 assert.deepEqual(inserted,{reports:manifest.counts.reports,attachments:manifest.counts.attachments,calls:manifest.counts.calls})
 assert.deepEqual(await importRecords(db,records),{reports:0,attachments:0,calls:0})
 const calls=(await db.query('SELECT payload FROM conference_call_archive WHERE code=$1',['ASB'])).rows
 assert.ok(calls.some(c=>JSON.stringify(c.payload.numbers).includes('비이자비용 19~20%')))
 assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('screener_snapshot','screener_user_data','screener_settings')",[schema])).rows[0].n,0)
 // Exercise merging into independently existing records, as on a seeded installation.
 await db.query("UPDATE screener_post SET body='keep-existing-edit' WHERE id=1")
 await db.query("UPDATE conference_call_archive SET payload=payload||'{\"headline\":\"keep-existing-edit\"}'::jsonb WHERE code='ASB'")
 await db.query('DELETE FROM data_transfer_applied')
 assert.deepEqual(await importRecords(db,records),{reports:0,attachments:0,calls:0})
 assert.equal((await db.query('SELECT body FROM screener_post WHERE id=1')).rows[0].body,'keep-existing-edit')
 assert.equal((await db.query("SELECT payload->>'headline' AS headline FROM conference_call_archive WHERE code='ASB'")).rows[0].headline,'keep-existing-edit')
 await db.query('DELETE FROM screener_file WHERE post_id=1');await db.query('DELETE FROM screener_post WHERE id=1')
 await db.query("DELETE FROM conference_call_archive WHERE code='ASB'")
 assert.deepEqual(await importRecords(db,records),{reports:0,attachments:0,calls:0})
 console.log(JSON.stringify({verified:inserted,repeat:'no duplicates',existingEdits:'preserved',deletions:'preserved',screeningData:'absent',restoredNumbers:'verified'}))
}finally{await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()}
