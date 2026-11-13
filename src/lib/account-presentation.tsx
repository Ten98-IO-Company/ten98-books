import {readResponseText} from '@ten98/runtime/browser';
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {ApiError,errMsg} from './api';
import {accountPreferencesWireDtoSchema,type AccountPreferencesDto} from './account-preferences';

export type AccountPresentation = {
  data:AccountPreferencesDto|null;
  loading:boolean;
  error:string;
  reload:()=>Promise<void>;
  accept:(value:AccountPreferencesDto)=>boolean;
  unavailable:(message:string)=>void;
};
export const AccountPresentationContext=createContext<AccountPresentation|null>(null);
export const useAccountPresentation=()=>useContext(AccountPresentationContext);

/**
 * The signed-in shell's saved preferences: read once per account, replaced by a verified save, and applied as the
 * document theme. Without saved preferences the browser's own light or dark setting applies.
 */
export function useAccountPresentationState(userId:string,onUnauthorized:()=>void):AccountPresentation {
  const [state,setState]=useState<{data:AccountPreferencesDto|null;loading:boolean;error:string}>({data:null,loading:false,error:''});
  const request=useRef<AbortController|null>(null);
  const reload=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    setState(previous=>({...previous,loading:true,error:''}));
    try{
      const data=await requestAccountPreferences(controller.signal);
      if(request.current!==controller)return;
      if(data.user.id!==userId){onUnauthorized();return;}
      setState({data,loading:false,error:''});
    }catch(error){
      if(request.current!==controller||controller.signal.aborted)return;
      if(error instanceof ApiError&&error.status===401){onUnauthorized();return;}
      setState({data:null,loading:false,error:errMsg(error)});
    }finally{if(request.current===controller)request.current=null;}
  },[userId,onUnauthorized]);
  useEffect(()=>{void reload();return()=>{request.current?.abort();request.current=null;};},[reload]);
  useEffect(()=>{
    document.documentElement.dataset.theme=state.data?.user.id===userId?state.data.preferences.theme:'system';
    return()=>{document.documentElement.dataset.theme='system';};
  },[state.data,userId]);
  return useMemo(()=>({...state,reload,
    accept:(data:AccountPreferencesDto)=>{if(data.user.id!==userId)return false;request.current?.abort();request.current=null;setState({data,loading:false,error:''});return true;},
    unavailable:(message:string)=>{request.current?.abort();request.current=null;setState({data:null,loading:false,error:message});},
  }),[state,reload,userId]);
}

// Shared by the actual shell read and explicit profile save; no browser persistence.
export async function requestAccountPreferences(callerSignal:AbortSignal,body?:unknown):Promise<AccountPreferencesDto> {
  const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(15000)]);
  try {
  let response:Response;
  try {response=await fetch('/api/account/preferences',{method:body===undefined?'GET':'POST',credentials:'same-origin',redirect:'error',signal,headers:{accept:'application/json',...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)}});}
  catch(error){if(signal.aborted)throw error;throw new ApiError('The request could not be confirmed. Reload saved preferences before trying again.');}
  if([401,403,404].includes(response.status)){
    void response.body?.cancel().catch(()=>{});const error=new ApiError(response.status===401?'Your session ended. Sign in again.':'Your account preferences are unavailable. Reload them to continue.');error.status=response.status;throw error;
  }
  if(response.ok&&response.status!==200){await response.body?.cancel();throw new Error('The account response could not be verified. Reload saved preferences.');}
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();throw new Error('The account response could not be verified. Reload saved preferences.');}
  if(!response.body)throw new Error('The account response was empty. Reload saved preferences.');
  let value:unknown;
  try{value=JSON.parse(await readResponseText(response,{maxBytes:8192,contentLength:'exact',signal}));}
  catch(error){
    if(signal.aborted)throw error;
    const code=(error as {code?:unknown}).code;
    if(error instanceof RangeError||code==='CONTENT_LENGTH_INVALID')throw new Error('The account response exceeded its limit. Reload saved preferences.');
    if(code==='RESPONSE_INCOMPLETE')throw new Error('The account response was incomplete. Reload saved preferences.');
    if(error instanceof SyntaxError||code==='RESPONSE_DECODE_INVALID')throw new Error('The account response could not be verified. Reload saved preferences.');
    throw new ApiError('The request could not be confirmed. Reload saved preferences before trying again.');
  }
  if(!response.ok){const error=new ApiError(typeof value==='object'&&value!==null&&'error'in value&&typeof value.error==='string'?value.error:'Account preferences could not be saved. Reload them before trying again.');error.status=response.status;throw error;}
  const parsed=accountPreferencesWireDtoSchema.safeParse(value);if(!parsed.success)throw new Error('The account response could not be verified. Reload saved preferences.');return parsed.data;
  } catch(error) {
    if(!callerSignal.aborted&&signal.aborted)throw new ApiError('The request timed out and could not be confirmed. Reload saved preferences before trying again.');
    throw error;
  }
}
