import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { closeSync, openSync, fstatSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
import { RackFault, RecordSchemas } from './contracts.ts';

export const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const json=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
/** Acknowledged records survive process restart. Replacement is atomic at the file boundary. */
export async function durable(path:string,value:unknown){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${randomUUID()}.tmp`,file=await open(temporary,'wx',0o600);
  try{await file.writeFile(json(value)+'\n');await file.sync();}finally{await file.close();}
  await rename(temporary,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
/** Operational records are private to the rack. Configuration revisions live in separate JSON files. */
export class RackStore {
  private db:DatabaseSync;private lock:number;private maxRecords:number;
  private constructor(root:string,lock:number,maxRecords:number){
    this.maxRecords=maxRecords;
    this.lock=lock;this.db=new DatabaseSync(join(root,'operations.sqlite'));
    const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if(version!==8&&(version!==0||tables.length)){this.db.close();closeSync(lock);throw new RackFault('STATE_FORMAT','Use a fresh environment state directory; incompatible state is retained');}
    this.db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; BEGIN; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=8; COMMIT;');
  }
  static async open(root:string,maxRecords:number){await mkdir(root,{recursive:true,mode:0o700});const path=join(root,'owner.lock'),fd=openSync(path,'a',0o600);try{await tryLockExclusive(fd);const a=fstatSync(fd),b=statSync(path);if(a.ino!==b.ino||a.dev!==b.dev)throw new Error('Lock identity changed');}catch{closeSync(fd);throw new RackFault('STATE_OWNED','Another EnvironmentDaemon owns this state directory');}return new RackStore(root,fd,maxRecords);}
  get<T>(kind:string,id:string):T|undefined{const row=this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id) as {body:string}|undefined;return row?RecordSchemas[kind]!.parse(JSON.parse(row.body)) as T:undefined;}
  list<T>(kind:string):T[]{return (this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid').all(kind) as Array<{body:string}>).map(row=>RecordSchemas[kind]!.parse(JSON.parse(row.body)) as T);}
  put(kind:string,id:string,value:unknown,recovery=false){value=RecordSchemas[kind]!.parse(value);if(!this.get(kind,id)&&(this.db.prepare('SELECT COUNT(*) count FROM records').get() as {count:number}).count>=this.maxRecords*(recovery?3:1))throw new RackFault('STATE_CAPACITY','Retained operational record capacity reached');this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind,id,json(value));}
  /** Commit a catalog batch wholly or leave it unchanged, including capacity failures. */
  transaction<T>(write:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=write();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  full(){return (this.db.prepare('SELECT COUNT(*) count FROM records').get() as {count:number}).count>=this.maxRecords;}
  close(){this.db.close();closeSync(this.lock);}
}
export async function readJson(path:string):Promise<unknown>{return JSON.parse(await readFile(path,'utf8'));}
