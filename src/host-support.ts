import {readFileSync} from 'node:fs';

export const executionProfiles=['macos-arm64','ubuntu-24.04-amd64','ubuntu-26.04-amd64'] as const;
export type ExecutionProfile = typeof executionProfiles[number];
export interface HostIdentity {platform:string; architecture:string; osRelease?:string}

/** Identifies an implemented host contract, not qualification evidence. Linux
 * execution is deliberately limited to the distribution/architecture we test;
 * a working executable alone never broadens the supported operating systems. */
export function executionHost(identity?:HostIdentity):ExecutionProfile {
  const host=identity??{platform:process.platform,architecture:process.arch,
    ...(process.platform==='linux'?{osRelease:readFileSync('/etc/os-release','utf8')}:{})};
  if(host.platform==='darwin'&&host.architecture==='arm64')return 'macos-arm64';
  if(host.platform==='linux'&&host.architecture==='x64'){
    const fields=new Map((host.osRelease??'').split('\n').flatMap(line=>{
      const match=/^([A-Z_]+)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]*))\s*$/.exec(line);
      return match?[[match[1]!,match[2]??match[3]??match[4]!]]:[];
    }));
    if(fields.get('ID')==='ubuntu'){
      const profile=executionProfiles.find(value=>value===`ubuntu-${fields.get('VERSION_ID')}-amd64`);
      if(profile)return profile;
    }
  }
  throw Object.assign(new Error('Host execution requires macOS arm64 or Ubuntu 24.04/26.04 amd64. See release qualification for verified profiles.'),{code:'HOST_UNSUPPORTED'});
}
