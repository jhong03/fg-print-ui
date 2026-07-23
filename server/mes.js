/*
 * Fetches label templates from the MES, cached per template id with a short TTL
 * so design changes propagate without hammering the MES on every print. If the
 * MES is briefly unreachable but we have a cached copy, we keep using it.
 *
 * Several print destinations can use different templates, so the cache is keyed
 * by template id rather than being a single slot.
 *
 * `reload(id)` forces a fresh fetch for one template (used by the "Reload
 * template" control) so a MES edit can be reflected on demand.
 */

const MES_BASE = (process.env.MES_BASE_URL || '').replace(/\/+$/, '');
const DEFAULT_TEMPLATE_ID = process.env.LABEL_TEMPLATE_ID || '11';
const TTL_MS = Number(process.env.TEMPLATE_TTL_MS || 5 * 60 * 1000);

// templateId -> { template, at, meta }
const cache = new Map();

async function fetchFresh(templateId) {
  if (!MES_BASE) throw new Error('MES_BASE_URL not configured');

  const url = `${MES_BASE}/api/label-templates/${templateId}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`MES responded ${res.status}`);

  const body = await res.json();
  const template = body.template || body;
  if (!template || !template.label || !Array.isArray(template.elements)) {
    throw new Error('unexpected template shape');
  }

  cache.set(String(templateId), {
    template,
    at: Date.now(),
    meta: {
      id: body.id ?? templateId,
      name: body.name || null,
      updatedAt: body.updated_at || null,
      elementCount: template.elements.length,
    },
  });
  return template;
}

// Used by print/preview. Serves cache within TTL; on fetch failure falls back to
// the last-known-good copy for that template if we have one.
async function getTemplate(templateId = DEFAULT_TEMPLATE_ID) {
  const key = String(templateId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.template;
  try {
    return await fetchFresh(key);
  } catch (err) {
    if (hit) {
      console.warn(`[mes] template ${key} fetch failed, using cached copy:`, err.message);
      return hit.template;
    }
    throw new Error('Could not load label template from MES: ' + err.message);
  }
}

// Force a fresh pull for one template (no fallback — the caller wants to know if
// it failed).
async function reload(templateId = DEFAULT_TEMPLATE_ID) {
  const key = String(templateId);
  await fetchFresh(key);
  return cache.get(key).meta;
}

module.exports = { getTemplate, reload, DEFAULT_TEMPLATE_ID, MES_BASE };
