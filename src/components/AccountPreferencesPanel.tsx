import {AccountProfileFlow,Alert,Button,DescriptionList,Stack,StatusLine,Text,type AccountProfileValues,type AuthNotice,type SelectOption} from '@ten98/ui';
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {ApiError,errMsg} from '../lib/api';
import {accountLocaleInventory,accountLocaleMapping,accountLocales,accountPreferencesDefaults,accountPreferencesWireInputSchema,canonicalAccountTimeZone,type AccountLocale,type AccountPreferencesInput,type AccountPreferencesDto} from '../lib/account-preferences';
import {requestAccountPreferences,useAccountPresentation} from '../lib/account-presentation';

type Draft=Omit<AccountPreferencesInput,'expectedRevision'>;
const localeOptions:SelectOption[]=accountLocaleInventory.map(([code,label,dir])=>({value:code,label:`${label} · ${code}`,lang:accountLocaleMapping(code).formatLocale,dir}));
const isLocale=(value:string|undefined):value is AccountLocale=>accountLocales.includes(value as AccountLocale);
const asDraft=(values:AccountProfileValues):Draft=>({name:values.name,timeZone:values.timeZone??'',locale:(isLocale(values.locale)?values.locale:accountPreferencesDefaults.locale),theme:values.theme});
const savedDraft=(data:AccountPreferencesDto):Draft=>({name:data.user.name,timeZone:data.preferences.timeZone,locale:data.preferences.locale,theme:data.preferences.theme});
const sameDraft=(a:Draft,b:Draft)=>a.name===b.name&&a.timeZone===b.timeZone&&a.locale===b.locale&&a.theme===b.theme;
const detectTimeZone=()=>canonicalAccountTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);

/** Request/authorization adapter around the canonical AccountProfileFlow: it owns the revision CAS, reload recovery and the router blocker. */
export function AccountPreferencesPanel({expectedUserId,onUnauthorized}:{expectedUserId:string;onUnauthorized:()=>void}){
  const account=useAccountPresentation(),[draft,setDraft]=useState<Draft|null>(null),[staged,setStaged]=useState<Draft|null>(null),[generation,setGeneration]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState<AuthNotice|undefined>(),[reloadRequired,setReloadRequired]=useState(false);
  const operation=useRef(0),request=useRef<AbortController|null>(null),mounted=useRef(true),locked=useRef(false);
  const acknowledged=useRef<AccountPreferencesDto|null>(null),root=useRef<HTMLElement>(null),formatHelp=useId();
  const data=account?.data?.user.id===expectedUserId?account.data:null;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current++;request.current?.abort();};},[]);
  // Every verified read or save remounts the flow from the saved values, discarding any local draft.
  useEffect(()=>{operation.current++;request.current?.abort();locked.current=false;setBusy(false);setError('');if(!data||data!==acknowledged.current){acknowledged.current=null;setNotice(undefined);}setReloadRequired(false);setStaged(null);setDraft(data?savedDraft(data):null);setGeneration(value=>value+1);},[data]);
  const blocked=!data||!draft||!!account?.loading||!!account?.error||busy;
  const saved=data?savedDraft(data):null;
  const changed=!!saved&&!!draft&&!sameDraft(draft,saved);
  useBlocker({shouldBlockFn:()=>changed&&!window.confirm('Discard your unsaved preferences?'),enableBeforeUnload:()=>changed});
  const zones=Array.from(new Set(['UTC',...(data?[data.preferences.timeZone]:[]),...Intl.supportedValuesOf('timeZone')])).sort();
  const onValuesChange=useCallback((values:AccountProfileValues)=>setDraft(asDraft(values)),[]);
  const fallback={name:'',...accountPreferencesDefaults};
  // Revision 0 means the server holds no row: the shown values are staged defaults that Save may commit unchanged.
  // The flow enables Save only while its draft differs from defaultValues, so an empty name (never a valid saved name)
  // stands for "nothing saved yet". The router blocker still follows `changed`, so untouched defaults never prompt.
  const baseline=saved&&data?.preferences.revision===0?{...saved,name:''}:saved??fallback;
  async function save(values:AccountProfileValues){
    if(blocked||locked.current||reloadRequired||!data||!account)return;
    const input=accountPreferencesWireInputSchema.safeParse({expectedRevision:data.preferences.revision,...asDraft(values)});
    if(!input.success){setError('Enter a name of 1–120 characters and choose a recognized named time zone and regional format.');return;}
    const generation=++operation.current,controller=new AbortController();request.current=controller;locked.current=true;setBusy(true);setError('');setNotice(undefined);
    const current=()=>mounted.current&&!controller.signal.aborted&&operation.current===generation;
    try{
      const saved=await requestAccountPreferences(controller.signal,input.data);if(!current())return;
      if(saved.user.id!==expectedUserId){account.unavailable('The signed-in account changed.');onUnauthorized();return;}
      acknowledged.current=saved;if(account.accept(saved))setNotice({tone:'success',text:'Preferences saved.'});else acknowledged.current=null;
    }catch(failure){
      if(!current())return;
      if(failure instanceof ApiError&&failure.status===401){account.unavailable('Your session ended.');onUnauthorized();return;}
      if(failure instanceof ApiError&&[403,404].includes(failure.status)){account.unavailable('Your account access changed. Reload saved preferences to continue.');return;}
      setReloadRequired(true);setError(failure instanceof ApiError&&failure.status===409?'Preferences changed on another device. Reload saved preferences before saving again.':errMsg(failure));
    }finally{if(current()){locked.current=false;request.current=null;setBusy(false);}}
  }
  function restoreDefaults(){if(!draft)return;setStaged({...draft,...accountPreferencesDefaults});setGeneration(value=>value+1);acknowledged.current=null;setError('');setNotice({tone:'info',text:'Defaults are staged. Save to apply them.'});}
  const zone=draft?canonicalAccountTimeZone(draft.timeZone):null,mapping=draft?accountLocaleMapping(draft.locale):null;
  // AccountProfileFlow has no per-field description prop, so the regional-format help is linked to the locale and
  // time zone controls here. It runs after every render because the flow may rewrite aria-describedby for its own errors.
  useEffect(()=>{for(const control of root.current?.querySelectorAll<HTMLElement>('select[name="locale"], input[role="combobox"]')??[]){const ids=(control.getAttribute('aria-describedby')??'').split(/\s+/).filter(Boolean);if(!ids.includes(formatHelp))control.setAttribute('aria-describedby',[...ids,formatHelp].join(' '));}});
  const preview=<Stack gap={2} role="group" aria-label="Draft format preview">
    <Text id={formatHelp} tone="muted" size="sm">Interface text is currently English. Regional format changes dates and numbers in account settings; report formats and applied report time zones stay unchanged.</Text>
    <Text tone="muted" size="sm">Preview only · your draft</Text>
    {mapping&&zone?<DescriptionList items={[
      {term:'Number',description:<Text as="span" lang={mapping.formatLocale} dir={mapping.direction}>{new Intl.NumberFormat(mapping.formatLocale).format(1234567.89)}</Text>},
      {term:'Date and time',description:<Text as="span" lang={mapping.formatLocale} dir={mapping.direction}>{new Intl.DateTimeFormat(mapping.formatLocale,{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date())}</Text>},
    ]}/>:<Text size="sm">This browser cannot preview that time zone. Choose a recognized named time zone to change it.</Text>}
  </Stack>;
  return <Stack as="section" ref={root} gap={4}>
    {account?.loading&&<StatusLine busy>Loading saved preferences…</StatusLine>}
    {account?.error&&<Alert tone="danger" title={account.error}/>}
    <AccountProfileFlow key={generation} title="Your account" description="Personal settings follow your account across companies. Changes apply after Save changes. Email and sign-in security are managed separately."
      email={data?.user.email??''} defaultValues={baseline} initialValues={staged??saved??undefined} onValuesChange={onValuesChange}
      localeOptions={localeOptions} timeZones={zones} onDetectTimeZone={detectTimeZone} preview={preview}
      messages={{locale:'Date and number format'}} onSubmit={save} busy={busy} disabled={blocked||reloadRequired} error={error||undefined} notice={notice}
      extraActions={<Button type="button" variant="secondary" disabled={blocked} onClick={restoreDefaults}>Restore default preferences</Button>}/>
    {/* Reload stays outside the flow's fieldset: it is the recovery action while the form is disabled after a failed read, a 409 or an unconfirmed save. */}
    <Button type="button" variant="secondary" disabled={busy||!!account?.loading} onClick={()=>{acknowledged.current=null;setNotice(undefined);void account?.reload();}}>Reload saved preferences</Button>
    <Text tone="muted" size="sm">Reload replaces unsaved edits. Preferences do not change financial values, exports or saved report evidence.</Text>
  </Stack>;
}
