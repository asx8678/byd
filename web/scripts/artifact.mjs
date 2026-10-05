// Turns the `--mode artifact` build into one self-contained page for the claude.ai artifact viewer:
// inlines the script and stylesheet, and drops the document skeleton that the viewer adds itself.
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../dist-artifact/', import.meta.url);
let html = readFileSync(new URL('index.html', dir), 'utf8');
const read = href => readFileSync(new URL(href.replace(/^\.\//, ''), dir), 'utf8');

html = html.replace(/<link rel="stylesheet"[^>]*href="(\.\/assets\/[^"]+\.css)"[^>]*>/g, (_, href) => `<style>\n${read(href)}</style>`);
let script = '';
html = html.replace(/<script type="module"[^>]*src="(\.\/assets\/[^"]+\.js)"[^>]*><\/script>\n?/g, (_, href) => { script = read(href); return ''; });
if (!script) throw new Error('no module script found in the build');
if (/<\/script/i.test(script)) throw new Error('the bundle contains </script>, which would end the inline script early');
// a function, not a string: in a replacement string `$&` means the matched text, and minified code is full of `$&&`
html = html.replace('</body>', () => `<script type="module">\n${script}</script>\n</body>`);

const skeleton = /^(<!doctype html>|<html[^>]*>|<\/html>|<head>|<\/head>|<body>|<\/body>|<meta charset[^>]*>|<meta name="viewport"[^>]*>)$/i;
html = html.split('\n').filter(line => !skeleton.test(line.trim())).join('\n');
if (!html.includes(script)) throw new Error('the inlined script differs from the bundle');
writeFileSync(new URL('atto2-garage-trainer.html', dir), html);
console.log(`dist-artifact/atto2-garage-trainer.html: ${(html.length / 1024).toFixed(1)} KB`);
