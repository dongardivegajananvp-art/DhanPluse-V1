export function isTrustedDhanPulsePreview(origin) {
  if (typeof origin !== 'string') return false;
  const prefix = 'https://deploy-preview-';
  const suffix = '--spectacular-gaufre-b5c029.netlify.app';
  if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) return false;
  const buildNumber = origin.slice(prefix.length, -suffix.length);
  return /^[0-9]+$/.test(buildNumber);
}
