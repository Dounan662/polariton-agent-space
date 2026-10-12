import {join} from 'node:path';
import type {Config} from '../../src/config.ts';
import type {ProviderModel} from '../../harness/provider-contracts.ts';
import {ProviderSettings} from '../../harness/providers.ts';

/** Give controlled-harness tests the same saved setup required of real workers.
 * Catalog reads and persistence make no model requests; the key is a sentinel. */
export async function configureTestProviders(config:Config,models?:ProviderModel[]){
  const settings=await ProviderSettings.open(join(config.stateRoot,'provider-settings'),{discoveryTimeoutMs:config.providerDiscoveryTimeoutMs,lockTimeoutMs:config.startupTimeoutMs});
  try{
    await settings.save(models?
      {id:config.provider,kind:'custom',name:'Test provider',baseURL:'https://provider.invalid/v1',protocol:'openai-completions',models,apiKey:'sentinel-fixture-provider-key'}:
      {id:config.provider,kind:'builtin',apiKey:'sentinel-fixture-provider-key'});
    await settings.setDefault(JSON.stringify([config.provider,config.model]));
  }finally{await settings.close();}
}
