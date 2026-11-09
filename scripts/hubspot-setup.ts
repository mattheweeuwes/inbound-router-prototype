// One-time HubSpot setup: creates the inbound_router property group and every property the router writes,
// in the portal the key belongs to. Safe to re-run: a property that already exists is checked, not recreated.
// Never prints the key.  Usage: npm run hubspot:setup
import { makeConfig } from '../src/config';
import { propertyDefinitions } from '../src/crm/hubspot';

const cfg = makeConfig();
if (!cfg.hubspotToken) {
  console.error('No HubSpot key: put HUBSPOT_SERVICE_KEY in .env first.');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${cfg.hubspotToken}`, 'Content-Type': 'application/json' };
const api = (path: string, init: RequestInit = {}) =>
  fetch(`https://api.hubapi.com${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });

const defs = propertyDefinitions();
let created = 0;
let existed = 0;
const problems: string[] = [];

for (const objectType of ['contacts', 'companies'] as const) {
  const g = await api(`/crm/v3/properties/${objectType}/groups`, { method: 'POST', body: JSON.stringify(defs.propertyGroup) });
  if (!g.ok && g.status !== 409) problems.push(`${objectType} group: ${g.status} ${(await g.text()).slice(0, 200)}`);
  for (const p of defs[objectType] as any[]) {
    const r = await api(`/crm/v3/properties/${objectType}`, { method: 'POST', body: JSON.stringify(p) });
    if (r.ok) { created++; continue; }
    if (r.status === 409) {
      existed++;
      const cur: any = await (await api(`/crm/v3/properties/${objectType}/${p.name}`)).json();
      const wantUnique = p.hasUniqueValue === true;
      if (cur.type !== p.type || cur.fieldType !== p.fieldType || wantUnique !== (cur.hasUniqueValue === true)) {
        problems.push(`${objectType}.${p.name} exists but differs: ${cur.type}/${cur.fieldType}, unique ${cur.hasUniqueValue === true}`);
      }
      continue;
    }
    problems.push(`${objectType}.${p.name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

const key: any = await (await api('/crm/v3/properties/companies/serif_account_key')).json();
const unique = key.hasUniqueValue === true;
console.log(`properties created ${created}, already there ${existed}; companies.serif_account_key is unique: ${unique}`);
for (const p of problems) console.log('PROBLEM', p);
process.exit(problems.length || !unique ? 1 : 0);
