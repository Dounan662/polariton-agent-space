import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig,type Config} from '../../src/config.ts';
import {applicationPaths} from '../../src/paths.ts';
import {RackConfig} from '../../src/environment/contracts.ts';

/** Bind all default peers and skills to the fixture's lifetime. Directly invoked
 * browser tests must never discover or contact an installed EnvironmentDaemon. */
export async function testConfig(stateRoot:string):Promise<Config>{
  const config=await loadConfig(),runtimeDirectory=applicationPaths({env:{POLARITON_DATA_DIR:stateRoot}}).runtime;
  const environmentConfig=join(stateRoot,'test-environment.json');
  await mkdir(stateRoot,{recursive:true});
  await writeFile(environmentConfig,JSON.stringify(RackConfig.parse({stateRoot:join(stateRoot,'test-environment'),socketPath:join(runtimeDirectory,'environment.sock')})));
  return {...config,stateRoot,runtimeDirectory,environmentConfig,sharedSkillsDir:join(stateRoot,'skills')};
}
