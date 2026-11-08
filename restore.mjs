import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {createHash,randomBytes} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {parseEnv} from 'node:util'

const here=path.dirname(fileURLToPath(import.meta.url))
const hash=b=>createHash('sha256').update(b).digest('hex')
export async function loadBundle(directory=here){
 const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'))
 if(manifest.version!==1||!Array.isArray(manifest.records)||!Array.isArray(manifest.cache)||manifest.cache.length)throw new Error('Invalid manifest')
 const safe=p=>typeof p==='string'&&!path.isAbsolute(p)&&!p.split(/[\\/]/).some(x=>x==='..'||x==='.'||!x)
 const records=[]
 for(const e of [...manifest.records,...manifest.cache]){
   if(!safe(e.file)||!(/^(records|cache)\//.test(e.file)))throw new Error('Invalid bundle path')
   const raw=await fs.readFile(path.join(directory,e.file))
   if(raw.length!==e.bytes||hash(raw)!==e.sha256)throw new Error(`Checksum mismatch: ${e.file}`)
   if(e.target){
     if(!safe(e.target)||!(/^data\/us-bars\/[A-Za-z0-9.^_=-]+\.json$/.test(e.target)||e.target==='data/us-catalog.json'||/^screener\/data\/[^/]+\.(json|csv|parquet)$/.test(e.target)))throw new Error('Invalid cache destination')
   }else{
     if(!['report','calls'].includes(e.kind))throw new Error('Invalid record kind')
     const data=JSON.parse(gunzipSync(raw,{maxOutputLength:128*1024*1024}))
     if(e.kind==='report')for(const f of data.files){
       const pdf=Buffer.from(f.data,'base64')
       if(pdf.length!==f.bytes||pdf.subarray(0,5).toString()!=='%PDF-'||hash(pdf)!==f.sha)throw new Error('Invalid PDF')
     }
     if(e.kind==='calls'&&data.some(c=>!c.code||typeof c.quarter!=='string'||c.code!==c.payload.code||c.quarter!==(c.payload.quarter??'')))throw new Error('Invalid call')
     if(e.kind==='snapshots')for(const s of data)if(!['KR','US'].includes(s.market)||!Array.isArray(JSON.parse(s.payload)))throw new Error('Invalid snapshot')
     records.push({...e,data})
   }
 }
 return {manifest,records}
}

export async function importRecords(db,records){
 await db.query('BEGIN')
 const counts={reports:0,attachments:0,calls:0}
 try{
   await db.query('SELECT pg_advisory_xact_lock(726260811)')
   await db.query(`CREATE TABLE IF NOT EXISTS screener_user(id BIGSERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,pass_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',verified BOOLEAN NOT NULL DEFAULT false,nickname TEXT)`)
   await db.query('ALTER TABLE screener_user ADD COLUMN IF NOT EXISTS nickname TEXT')
   await db.query(`CREATE TABLE IF NOT EXISTS screener_post(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES screener_user(id),title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',cat TEXT NOT NULL DEFAULT 'report',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ)`)
   await db.query("ALTER TABLE screener_post ADD COLUMN IF NOT EXISTS cat TEXT NOT NULL DEFAULT 'free'")
   await db.query(`CREATE TABLE IF NOT EXISTS screener_file(id BIGSERIAL PRIMARY KEY,user_id BIGINT,uploader TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',filename TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,sha TEXT NOT NULL,data TEXT NOT NULL,post_id BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),downloads INTEGER NOT NULL DEFAULT 0)`)
   await db.query('ALTER TABLE screener_file ADD COLUMN IF NOT EXISTS post_id BIGINT')
   await db.query(`CREATE TABLE IF NOT EXISTS conference_call_archive(code TEXT NOT NULL,quarter TEXT NOT NULL,call_date TEXT NOT NULL DEFAULT '',payload JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(code,quarter))`)
   // The target is an installed TradingManager. Keep its owner, secrets and schema.
   let owner=(await db.query("SELECT id FROM screener_user WHERE role='admin' ORDER BY id LIMIT 1")).rows[0]
   if(!owner)owner=(await db.query("INSERT INTO screener_user(email,pass_hash,role,verified,nickname) VALUES('local@tm26.invalid',$1,'admin',true,'TM26') ON CONFLICT(email) DO UPDATE SET role='admin',verified=true RETURNING id",[randomBytes(48).toString('hex')])).rows[0]
   await db.query('CREATE TABLE IF NOT EXISTS data_transfer_applied(key TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
   await db.query('CREATE TABLE IF NOT EXISTS content_seed_applied(key TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
   for(const entry of records){
     if(entry.kind==='report'){
       const p=entry.data,key=`macmini:report:${p.id}:${p.created_at}`
       if(!(await db.query('INSERT INTO data_transfer_applied(key) VALUES($1) ON CONFLICT DO NOTHING RETURNING key',[key])).rowCount)continue
       const oldFiles=p.files.length?(await db.query('SELECT id,sha,post_id FROM screener_file WHERE sha=ANY($1::text[]) AND post_id IS NOT NULL ORDER BY id',[p.files.map(f=>f.sha)])).rows:[]
       let postId=oldFiles[0]?.post_id,newPost=false
       if(!postId){
         const same=(await db.query("SELECT id FROM screener_post WHERE cat='report' AND title=$1 AND body=$2 AND created_at=$3 LIMIT 1",[p.title,p.body,p.created_at])).rows[0]
         postId=same?.id
       }
       if(!postId){postId=(await db.query("INSERT INTO screener_post(user_id,title,body,cat,created_at,updated_at) VALUES($1,$2,$3,'report',$4,$5) RETURNING id",[owner.id,p.title,p.body,p.created_at,p.updated_at])).rows[0].id;newPost=true;counts.reports++}
       const idMap=new Map()
       for(const f of p.files){
         const existing=oldFiles.find(x=>x.sha===f.sha)
         let fileId=existing?.id
         if(!fileId){fileId=(await db.query("INSERT INTO screener_file(user_id,uploader,title,note,filename,mime,bytes,sha,data,post_id,created_at) VALUES($1,'TradingManager',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",[owner.id,f.title,f.note,f.filename,f.mime,f.bytes,f.sha,f.data,postId,f.created_at])).rows[0].id;counts.attachments++}
         idMap.set(String(f.id),String(fileId))
         await db.query('INSERT INTO content_seed_applied(key) VALUES($1) ON CONFLICT DO NOTHING',[`report:${f.sha}`])
       }
       if(newPost){
         const body=p.body.replace(/(\/api\/files\/get\?id=)(\d+)/g,(all,prefix,id)=>idMap.has(id)?prefix+idMap.get(id):all)
         await db.query('UPDATE screener_post SET body=$1 WHERE id=$2',[body,postId])
       }
     }else if(entry.kind==='calls'){
       for(const c of entry.data){
         const claim=await db.query('INSERT INTO data_transfer_applied(key) VALUES($1) ON CONFLICT DO NOTHING RETURNING key',[`macmini:call:${c.code}|${c.quarter}`])
         if(!claim.rowCount)continue
         counts.calls+=(await db.query('INSERT INTO conference_call_archive(code,quarter,call_date,payload,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(code,quarter) DO NOTHING',[c.code,c.quarter,c.call_date,c.payload,c.updated_at])).rowCount
         await db.query('INSERT INTO content_seed_applied(key) VALUES($1) ON CONFLICT DO NOTHING',[`call:${c.code}|${c.quarter}`])
       }
     }
   }
   await db.query('COMMIT');return counts
 }catch(error){await db.query('ROLLBACK');throw error}
}

async function main(){
 const args=process.argv.slice(2),targetArg=args.find(a=>!a.startsWith('--'))
 if(!targetArg)throw new Error('Usage: node restore.mjs /path/to/TradingManager [--check]')
 const target=await fs.realpath(targetArg)
 const {manifest,records}=await loadBundle()
 console.log('검증 완료:',manifest.counts)
 const config=parseEnv(await fs.readFile(path.join(target,'web/.env.local'),'utf8'))
 const url=new URL(config.DATABASE_URL)
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('로컬 PostgreSQL만 지원합니다.')
 if(args.includes('--check')){console.log('검사만 완료. DB와 파일은 변경하지 않았습니다.');return}
 const {default:pg}=await import(createRequire(path.join(target,'web/package.json')).resolve('pg'))
 const db=new pg.Client({connectionString:url.href})
 await db.connect()
 try{
   const result=await importRecords(db,records);console.log('추가한 DB 자료:',result)
 }finally{await db.end()}
 console.log('리포트·컨퍼런스콜 추가 완료. 앱에서 자료를 새로고침하세요.')
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1})
