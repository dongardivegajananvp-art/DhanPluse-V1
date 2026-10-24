import fs from 'node:fs';

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const navBlock = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/);
if (!navBlock) throw new Error('Navigation block #nav is missing.');

const navTabs = [...navBlock[1].matchAll(/data-tab="([^"]+)"/g)]
  .map(match => match[1].replace(/&amp;/g, '&'));
const descriptionsBlock = app.match(/const descriptions = \{([\s\S]*?)\n\};/);
if (!descriptionsBlock) throw new Error('Tab descriptions registry is missing.');
const describedTabs = [...descriptionsBlock[1].matchAll(/^\s*'([^']+)':\s*\[/gm)]
  .map(match => match[1]);

const duplicates = values => values.filter((value, index) => values.indexOf(value) !== index);
const missingNavigation = describedTabs.filter(tab => !navTabs.includes(tab));
const missingDescription = navTabs.filter(tab => !describedTabs.includes(tab));
const duplicateNav = duplicates(navTabs);
if (navTabs.length !== 24 || describedTabs.length !== 24 ||
    missingNavigation.length || missingDescription.length || duplicateNav.length) {
  console.error(JSON.stringify({ navCount: navTabs.length, descriptionCount: describedTabs.length,
    missingNavigation, missingDescription, duplicateNav }, null, 2));
  process.exit(1);
}
console.log('Tab audit passed: all 24 tabs have navigation and descriptions.');
