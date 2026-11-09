import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dirOf, PUBLIC } from '../server';

describe('static root', () => {
  it('resolves to the real public/ folder, with the cockpit and its self-hosted font in it', () => {
    assert.ok(statSync(PUBLIC).isDirectory(), PUBLIC);
    for (const f of ['index.html', 'app.js', 'styles.css', join('fonts', 'sora-latin.woff2'), join('fonts', 'OFL.txt'), join('mock', 'dashboard.json')]) {
      assert.ok(existsSync(join(PUBLIC, f)), `public/${f}`);
    }
  });

  it('decodes a module URL into a path, so a folder with a space in its name works', () => {
    assert.equal(dirOf('file:///Users/demo/My%20Projects/app/server.ts'), '/Users/demo/My Projects/app/');
    assert.doesNotMatch(PUBLIC, /%[0-9A-F]{2}/i);
  });
});
