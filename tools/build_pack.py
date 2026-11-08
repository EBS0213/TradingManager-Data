"""Build a reports/calls pack from an audited DB export and publication originals."""
from pathlib import Path
import argparse,base64,collections,gzip,hashlib,json,shutil,zipfile

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('export',type=Path);p.add_argument('seed',type=Path);p.add_argument('publications',type=Path);p.add_argument('output',type=Path)
 args=p.parse_args();args.output.mkdir(parents=True,exist_ok=False)
 (args.output/'records').mkdir()
 digest=lambda b:hashlib.sha256(b).hexdigest()
 read=lambda p:json.loads(gzip.decompress(p.read_bytes()))
 source=json.loads((args.export/'manifest.json').read_text())
 manifest={'version':1,'pack':'TradingManager Research','release':'2026.11.08','createdAt':source['createdAt'],
           'origin':'Mac mini research archive + GitHub publication originals','records':[],'cache':[],
           'scope':['reports','conference-calls'],'screeningDataIncluded':False,'counts':{}}
 def save(kind,name,data):
  raw=gzip.compress(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode(),mtime=0)
  file='records/'+name+'.json.gz';(args.output/file).write_bytes(raw)
  manifest['records'].append({'kind':kind,'file':file,'bytes':len(raw),'sha256':digest(raw)})
 posts=[];calls={};hashes=set();files=0
 for e in source['records']:
  raw=(args.export/e['file']).read_bytes();assert digest(raw)==e['sha256']
  d=read(args.export/e['file'])
  if e['kind']=='report':
   for f in d['files']:
    data=base64.b64decode(f['data']);assert len(data)==f['bytes'] and digest(data)==f['sha'];hashes.add(f['sha']);files+=1
   posts.append(d)
  elif e['kind']=='calls':
   for c in d:calls[(c['code'],c['quarter'])]=c
 originals={}
 for path in sorted(args.publications.rglob('콜게시_*.json')):
  for d in json.loads(path.read_text()).get('items',[]):originals[(d['code'],d['quarter'])]=d
 old=json.loads((args.seed/'manifest.json').read_text())
 for e in old['entries']:
  raw=(args.seed/e['file']).read_bytes();assert digest(raw)==e['sha256']
  d=read(args.seed/e['file'])
  if e['kind']=='call':originals[(d['code'],d['quarter'])]=d
  elif d['sha'] not in hashes:
   data=base64.b64decode(d['data']);assert digest(data)==d['sha'] and len(data)==d['bytes']
   hashes.add(d['sha']);files+=1
   # The historical creation date is inferred from the dated publication filename.
   import re
   match=re.search(r'(20\d{2})\.(\d{2})\.(\d{2})',d['filename'])
   date='-'.join(match.groups())+'T00:00:00+09:00' if match else None
   posts.append({'id':'github-'+d['sha'],'title':d['title'],'body':'기업분석 보고서 · 첨부 PDF에서 내용을 확인하세요.',
     'created_at':date,'updated_at':None,'cat':'report','files':[{'id':'github-'+d['sha'],
     'created_at':date,'note':'',**d}]})
 fixed=0;modern=0;allowed={'code','name','market','quarter','date','sector','headline','summary','call','industry','outlook','numbers','sources','documents','pipeline','transcriptSource','madeAt'}
 for key,c in calls.items():
  d=c['payload'];original=originals.get(key)
  if (d.get('pipeline') or {}).get('id')=='foolcalls-codex-v1':
   modern+=1
   assert original and (original.get('documents') or {}).get('sha256')==(d.get('documents') or {}).get('sha256'),key
   if d.get('numbers')!=original.get('numbers'):d['numbers']=original['numbers'];fixed+=1
  docs=d.get('documents') or {}
  if docs.get('original'):
   assert digest(docs['original'].encode())==docs['sha256']
   assert docs['translation']['sourceSha256']==docs['sha256']
  c['payload']={k:v for k,v in d.items() if k in allowed}
 for i,p in enumerate(posts):save('report',f'report-{i:04}',p)
 ordered=[calls[k] for k in sorted(calls)]
 for i in range(0,len(ordered),100):save('calls',f'calls-{i//100:03}',ordered[i:i+100])
 manifest['counts']={'reports':len(posts),'attachments':files,'calls':len(calls),'modernCalls':modern,
  'legacyCalls':len(calls)-modern,'callsWithRestoredNumbers':fixed,'snapshots':0,'settings':0,'cacheFiles':0}
 manifest['notes']=['회사·작성일이 같은 다른 PDF 판본은 보존합니다.','구형 콜 중 일부는 원문·번역 전문이 없습니다.','스크리너 결과·시세 캐시·계정·인증키·개인 매매 기록은 포함하지 않습니다.']
 (args.output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
 root=Path(__file__).resolve().parents[1]
 for name in ['restore.mjs','Install-macOS.command','Install-Windows.cmd','README.md','DATA-NOTICE.txt']:
  shutil.copy2(root/name,args.output/name)
 asset=Path(str(args.output)+'.zip')
 with zipfile.ZipFile(asset,'w',compression=zipfile.ZIP_STORED,allowZip64=True) as z:
  for file in sorted(args.output.rglob('*')):
   if file.is_file():z.write(file,arcname=args.output.name+'/'+str(file.relative_to(args.output)))
 checksum=hashlib.file_digest(asset.open('rb'),'sha256').hexdigest()
 asset.with_suffix('.zip.sha256').write_text(checksum+'  '+asset.name+'\n')
 print(json.dumps({'counts':manifest['counts'],'asset':str(asset),'bytes':asset.stat().st_size,'sha256':checksum},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
