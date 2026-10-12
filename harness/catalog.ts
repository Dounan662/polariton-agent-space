import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../src/config.ts';
import type { HarnessFactory } from './contracts.ts';

export const ModelChoices=z.array(z.object({value:z.string(),name:z.string(),image:z.boolean()}).strict());
export type ModelChoice=z.infer<typeof ModelChoices>[number];
export interface ModelCatalog { choices():Promise<ModelChoice[]> }

/** A single bounded DSH host reads the configured provider's catalog, without any conversation. */
export class HarnessCatalog implements ModelCatalog {
  private pending?:Promise<ModelChoice[]>;
  private config:Config;private factory:HarnessFactory;
  constructor(config:Config,factory:HarnessFactory){this.config=config;this.factory=factory;}
  choices():Promise<ModelChoice[]>{
    if(!this.pending)this.pending=this.read().catch(error=>{this.pending=undefined;throw error;});
    return this.pending;
  }
  async close(){await this.pending?.catch(()=>{});}
  private async read(){
    const root=join(this.config.stateRoot,'catalog');await mkdir(root,{recursive:true,mode:0o700});
    const home=await mkdtemp(join(root,'read-'));
    const harness=this.factory({...this.config,requestTimeoutMs:this.config.startupTimeoutMs},home,home,async()=>false,async()=>({outcome:'cancelled'}));
    try{await harness.start();return await harness.models();}
    finally{await harness.close();await rm(home,{recursive:true,force:true});}
  }
}
