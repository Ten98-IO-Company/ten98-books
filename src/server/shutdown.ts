import {definePlugin} from 'nitro';
import {useNitroHooks} from 'nitro/app';
import {closeRuntimeResources} from './resource-cleanup.ts';

export default definePlugin(()=>{
  useNitroHooks().hook('close',closeRuntimeResources);
});
