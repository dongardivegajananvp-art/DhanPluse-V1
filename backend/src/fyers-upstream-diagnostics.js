const MAX_PREVIEW_LENGTH = 320;

function headerValue(headers, name) {
  try { return headers?.get?.(name) || null; } catch { return null; }
}

export function summarizeFyersUpstreamFailure({ responseText = '', headers = null, apiCode = null } = {}) {
  const body = String(responseText || '');
  const compact = body.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const codeMatch = body.match(/(?:cloudflare\s*)?(?:error\s*)?(1010|1015|1020|1021|1022|1033|1101|1102)/i);
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;

  return {
    apiCode: apiCode == null ? null : String(apiCode).slice(0, 40),
    cloudflareErrorCode: codeMatch ? codeMatch[1] : null,
    responseContentType: headerValue(headers, 'content-type'),
    cloudflareRayId: headerValue(headers, 'cf-ray'),
    cloudflareMitigation: headerValue(headers, 'cf-mitigated'),
    upstreamServer: headerValue(headers, 'server'),
    retryAfter: headerValue(headers, 'retry-after'),
    responseTitle: title ? title.slice(0, 120) : null,
    responseBodyPreview: compact ? compact.slice(0, MAX_PREVIEW_LENGTH) : null
  };
}
