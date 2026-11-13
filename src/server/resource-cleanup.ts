type Cleanup=()=>Promise<void>;
type Resources={jobs:Set<Cleanup>;database:Set<Cleanup>;closing?:Promise<void>};
const key=Symbol.for('ten98-books.runtime-resource-cleanup');
const shared=globalThis as typeof globalThis&{[key]?:Resources};
function resources() {return shared[key]??={jobs:new Set<Cleanup>(),database:new Set<Cleanup>()};}

// Nitro's entry and TanStack's SSR routes are separate bundles. Register the
// closures belonging to the opened resources instead of importing duplicate singletons.
export function registerResourceCleanup(kind:'jobs'|'database',cleanup:Cleanup) {
  resources()[kind].add(cleanup);
}

export function closeRuntimeResources():Promise<void> {
  const state=resources();
  return state.closing??=(async()=>{
    // A queue's shutdown may still need the application database.
    for(const kind of ['jobs','database'] as const) {
      await Promise.all([...state[kind]].map(async cleanup=>{
        try {await cleanup();}
        catch {
          console.error(kind==='jobs'?'Job shutdown failed.':'Database shutdown failed.');
          process.exitCode=1;
        }
      }));
    }
  })();
}
