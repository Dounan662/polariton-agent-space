import {mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Allocate disposable storage outside source and user data. Canonical paths keep
 * workspace identity stable on hosts whose temporary directory is a symlink.
 * The caller removes its directory after closing every owner of its files. */
export async function temporaryDirectory(prefix:string):Promise<string>{
  return mkdtemp(join(await realpath(tmpdir()),prefix));
}

