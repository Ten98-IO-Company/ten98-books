import { z } from 'zod';

// Formatting locales for dates and numbers. This list does not claim translated screens (UI localisation is M3, D-09).
export const accountLocaleInventory = [
  ['en-US','English (US)','ltr'], ['en-GB','English (UK)','ltr'], ['ar-SA','العربية','rtl'],
] as const;
export const accountLocales = accountLocaleInventory.map(([code])=>code);
export type AccountLocale = typeof accountLocales[number];
export const accountThemes = ['light','dark','system'] as const;
export const accountPreferencesDefaults = Object.freeze({ timeZone:'UTC', locale:'en-US' as AccountLocale, theme:'light' as typeof accountThemes[number] });
export const accountPreferencesMaxRevision = 2147483647;

export function accountLocaleMapping(locale:AccountLocale) {
  const [code,label,direction]=accountLocaleInventory.find(([code])=>code===locale)!;
  return {code,label,direction,formatLocale:code};
}

const clean=(value:string)=>!/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
export function canonicalAccountTimeZone(value:string):string|null {
  if(value.length>80||!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value))return null;
  try { return new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone; } catch { return null; }
}
const name=z.string().trim().min(1).max(120).refine(clean);
const timeZone=z.string().min(1).max(80).transform((value,context)=>{
  const zone=canonicalAccountTimeZone(value);if(zone!==null)return zone;
  context.addIssue({code:'custom',message:'Choose a recognized named time zone.'});return z.NEVER;
});
export const accountPreferencesInputSchema=z.object({
  expectedRevision:z.number().int().min(0).max(accountPreferencesMaxRevision),name,timeZone,
  locale:z.enum(accountLocales),theme:z.enum(accountThemes),
}).strict();
export type AccountPreferencesInput=z.output<typeof accountPreferencesInputSchema>;
export const accountPreferencesDtoSchema=z.object({
  version:z.literal('account-preferences-v1'),
  user:z.object({id:z.string().min(1).max(128).refine(clean),name,email:z.email().max(254)}).strict(),
  preferences:z.object({
    revision:z.number().int().min(0).max(accountPreferencesMaxRevision),
    timeZone:z.string().min(1).max(80).refine(value=>canonicalAccountTimeZone(value)!==null),
    locale:z.enum(accountLocales),theme:z.enum(accountThemes),updatedAt:z.iso.datetime().nullable(),
  }).strict(),
}).strict().refine(value=>(value.preferences.revision===0)===(value.preferences.updatedAt===null));
export type AccountPreferencesDto=z.output<typeof accountPreferencesDtoSchema>;

// Server/storage validation stays strict above. A client can have different IANA data;
// preserve the server's bounded identifier and check local formatting separately.
export const accountPreferencesWireDtoSchema=accountPreferencesDtoSchema.safeExtend({
  preferences:accountPreferencesDtoSchema.shape.preferences.safeExtend({
    timeZone:z.string().min(1).max(80).refine(clean).regex(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/),
  }),
});

// Client input preserves named identifiers; the server still recognizes and canonicalizes explicit saves.
export const accountPreferencesWireInputSchema=accountPreferencesInputSchema.safeExtend({
  timeZone:accountPreferencesWireDtoSchema.shape.preferences.shape.timeZone,
});
