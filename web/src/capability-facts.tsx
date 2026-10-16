import React from 'react';
import type {ComponentView,PackageInstallation} from '../../src/environment/preparation-contracts.ts';
import type {ManagedCapability,Release} from '../../src/environment/contracts.ts';

/** Keep the five properties scannable throughout setup. Default summaries expose
 * readiness and constraints; provenance and diagnostics stay in the disclosure.
 * Connection observations belong to the supplied environment scope. */
export function CapabilityFacts({value,authentication,connectionEvidence,platform,installation}:{value:ComponentView;authentication?:React.ReactNode;connectionEvidence?:React.ReactNode;platform?:Pick<PackageInstallation,'platform'|'arch'>;installation?:PackageInstallation}){
 const {source,runtime,connection,requirements,evidence}=value;
 const origin='url'in source?source.url:'identifier'in source?source.identifier:source.kind==='git'?source.directory:source.kind==='oci'?source.image.split('@')[0]!:source.command.split('/').at(-1)!;
 const link=source.kind==='npm'?`https://www.npmjs.com/package/${source.identifier}`:source.kind==='pypi'?`https://pypi.org/project/${source.identifier}/`:source.kind==='cargo'?`https://crates.io/crates/${source.identifier}`:source.kind==='nuget'?`https://www.nuget.org/packages/${source.identifier}/`:undefined;
 const toolchain=source.kind==='npm'?'Node.js and npm':source.kind==='pypi'?'Python and uv':source.kind==='nuget'?'.NET':source.kind==='cargo'?'Cargo and Rust':null;
 const dependencies=[toolchain,...requirements.assets.map(asset=>`Playwright ${asset.browser}`),requirements.files.length?`${requirements.files.length} prerequisite ${requirements.files.length===1?'file':'files'}`:null].filter(Boolean).join(' · ');
 return <div className="capability-properties">
  <section><h2>Source</h2><p>{source.kind==='installed'?'Existing installation · ':source.kind==='oci'?'Container image · ':source.kind==='git'?'Git · ':''}{link?<a href={link} target="_blank" rel="noreferrer">{origin}</a>:<Origin value={origin}/>} {'version'in source&&<span className="muted">· {source.version}</span>}</p></section>
  <section><h2>Runtime</h2><p>{runtime.kind==='local'?'Local process':runtime.kind==='container'?'Managed container':'External service'}</p></section>
  <section><h2>Connection</h2><p>{connection.kind==='stdio'?'stdio':'Streamable HTTP'}{!connectionEvidence&&` · ${evidence.connection==='untested'?'Connection untested':evidence.connection==='connected'?'Connected':'Connection failed'}`}</p>
   {connectionEvidence??<>{evidence.connection==='connected'&&<p className="muted">{evidence.tools.length} {evidence.tools.length===1?'tool':'tools'} discovered</p>}
   {evidence.checks.filter(check=>check.status==='failed').map(check=><p className="environment-error" key={check.name}>{check.name}: failed</p>)}</>}
  </section>
  <section><h2>Requirements</h2><p className={evidence.dependencies==='unavailable'?'environment-error':undefined}>{evidence.dependencies==='ready'?'Dependencies ready':evidence.dependencies==='unavailable'?'Dependencies unavailable':'Dependencies need setup'}</p>
   {evidence.dependencies!=='ready'&&dependencies&&<p className="muted">{dependencies}</p>}
   {requirements.storage&&<p>Retained storage · {requirements.storage.scope} scope · {requirements.storage.access} access</p>}
   {requirements.resource&&<p>{requirements.resource.identity} · {requirements.resource.exclusive?'exclusive access':'shared access'}</p>}
  </section>
  <section><h2>Authentication</h2>{authentication??<p>{value.authentication.kind==='none'?'No authentication configured':`${value.authentication.kind==='static'?'Private credentials':'Account connection'} · ${evidence.authentication==='connected'?'Connected':evidence.authentication==='action-needed'?'Action needed':'Credentials referenced'}`}</p>}</section>
  {value.error&&<p role="status" className="environment-error capability-error">{value.error.message} ({value.error.code})</p>}
  <details><summary>Technical details</summary>
   <dl className="environment-facts">
    {value.capabilityRevisionId&&<><dt>Capability version</dt><dd><code>{value.capabilityRevisionId}</code></dd></>}
    <dt>Registration</dt><dd>{evidence.registered?'Registered':'Not yet registered'}</dd>
    {platform&&<><dt>Platform</dt><dd>{platform.platform} / {platform.arch}</dd></>}
    {toolchain&&<><dt>Toolchain</dt><dd>{toolchain}</dd></>}
    {!!requirements.assets.length&&<><dt>Browser assets</dt><dd>{requirements.assets.map(asset=>`Playwright ${asset.browser}`).join(', ')}</dd></>}
   </dl>
   <p className="muted">{runtime.kind==='local'?'Each access starts a separate foreground process with temporary storage and your host account’s authority.':runtime.kind==='container'?'Apply an environment to prepare its managed runtime before assigning workers.':'The service is operated outside Polariton.'}</p>
   <pre>{JSON.stringify(value,null,2)}</pre>{installation&&<><h3>Installed package</h3><pre>{JSON.stringify(installation,null,2)}</pre></>}
  </details>
 </div>;
}

export function Origin({value}:{value:string}){return /^https?:\/\//.test(value)?<a href={value} target="_blank" rel="noreferrer">{value}</a>:<span>{value}</span>;}

/** Managed packages select immutable releases in each environment. Their common
 * contract must not present the most recent installation as every consumer's version. */
export function ManagedCapabilityFacts({value,releases}:{value:ManagedCapability;releases:Release[]}){
 return <div className="capability-properties">
  <section><h2>Source</h2><p><Origin value={value.source.repository}/></p><p className="muted">{releases.length?`${releases.length} installed ${releases.length===1?'release':'releases'}`:'Awaiting installation'}</p></section>
  <section><h2>Runtime</h2><p>Managed container</p></section>
  <section><h2>Connection</h2><p>Streamable HTTP · Validation belongs to each environment</p></section>
  <section><h2>Requirements</h2><p>Container runtime and declared build dependencies</p></section>
  <section><h2>Authentication</h2><p>Environment-owned access grant</p></section>
  <details><summary>Technical details</summary><p>Git directory: {value.source.subdirectory||'Repository root'}</p><p>Apply an environment to start its selected release. Each release declares its configuration and base image. Instances use scratch storage; resource sharing is selected in the environment.</p><p>Each worker receives access to its assigned environment version. Connection and discovery are observed for that version.</p><pre>{JSON.stringify(value,null,2)}</pre></details>
 </div>;
}
