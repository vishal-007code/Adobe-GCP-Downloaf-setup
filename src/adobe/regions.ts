/**
 * The client runs two kinds of accounts, and each has its own postcard template to download:
 * KVS (Kendriya Vidyalaya) and Bihar (state school districts).
 */
export type AdobeRegion = 'kvs' | 'bihar';
export const ADOBE_REGIONS: readonly AdobeRegion[] = ['kvs', 'bihar'];

export const REGION_TEMPLATE_URLS: Record<AdobeRegion, string> = {
  kvs: 'https://new.express.adobe.com/design/template/urn:aaid:sc:VA6C2:fcf64e48-8456-5141-9d68-55b0d404d468',
  bihar: 'https://new.express.adobe.com/design/template/urn:aaid:sc:VA6C2:e1cb7d5d-5c61-5064-bfb1-a1d1e94b693e',
};

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

/**
 * The region an email domain belongs to, or undefined when it fits neither rule.
 * Every KVS domain run so far contains "kvs" (cha.kvs.ac.in, kvsromumbai.in, rokvsagra.in,
 * elearnkvsroblr.in); every Bihar one is <district>.<division>edu.in (ar.purniaedu.in,
 * pa.patnaedu.in, mu.tirhutedu.in). An accounts CSV can override this per row with a
 * Region column.
 */
export function regionFromEmail(email: string): AdobeRegion | undefined {
  const domain = emailDomain(email);
  if (domain.includes('kvs')) return 'kvs';
  if (domain.endsWith('edu.in')) return 'bihar';
  return undefined;
}

export function parseRegion(value: string): AdobeRegion | undefined {
  const normalized = value.trim().toLowerCase();
  return ADOBE_REGIONS.find((region) => region === normalized);
}
