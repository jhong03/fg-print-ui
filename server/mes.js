/*
 * Fetches the active label template from the MES, cached with a short TTL so
 * design changes propagate without hammering the MES on every print. If the MES
 * is briefly unreachable but we have a cached copy, we keep using it.
 *
 * `reload()` forces a fresh fetch (used by the "Reload template" control) so a
 * MES edit can be reflected on demand.
 */

const MES_BASE = (process.env.MES_BASE_URL || '').replace(/\/+$/, '');
const TEMPLATE_ID = process.env.LABEL_TEMPLATE_ID || '11';
const TTL_MS = Number(process.env.TEMPLATE_TTL_MS || 5 * 60 * 1000);

let cache = { template: null, at: 0, meta: null };

async function fetchFresh() {
  if (!MES_BASE) throw new Error('MES_BASE_URL not configured');

  const url = `${MES_BASE}/api/label-templates/${TEMPLATE_ID}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`MES responded ${res.status}`);

  const body = await res.json();
  const template = body.template || body;
  if (!template || !template.label || !Array.isArray(template.elements)) {
    throw new Error('unexpected template shape');
  }

  cache = {
    template,
    at: Date.now(),
    meta: {
      id: body.id ?? TEMPLATE_ID,
      name: body.name || null,
      updatedAt: body.updated_at || null,
      elementCount: template.elements.length,
    },
  };
  return template;
}

// Used by print/preview. Serves cache within TTL; on fetch failure falls back to
// the last-known-good copy if we have one.
async function getTemplate() {
  const fresh = cache.template && Date.now() - cache.at < TTL_MS;
  if (fresh) return cache.template;
  try {
    return await fetchFresh();
  } catch (err) {
    if (cache.template) {
      console.warn('[mes] template fetch failed, using cached copy:', err.message);
      return cache.template;
    }
    throw new Error('Could not load label template from MES: ' + err.message);
  }
}

// Force a fresh pull (no fallback — the caller wants to know if it failed).
async function reload() {
  await fetchFresh();
  return cache.meta;
}

module.exports = { getTemplate, reload, TEMPLATE_ID, MES_BASE };
