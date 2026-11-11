import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config';
import { ACCESS_REALM, httpsRedirect, passwordFrom, refuseAccess } from '../src/access';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

describe('access gate for a copy reachable from outside', () => {
  it('is off unless ACCESS_PASSWORD is set, so the local server answers as before', () => {
    assert.equal(makeConfig({}, {}).accessPassword, null);
    assert.equal(makeConfig({}, { ACCESS_PASSWORD: '   ' }).accessPassword, null, 'a blank setting is no password');
    assert.equal(makeConfig({}, { ACCESS_PASSWORD: ' open-sesame ' }).accessPassword, 'open-sesame');
    assert.equal(refuseAccess(undefined, null), null);
    assert.equal(refuseAccess('Basic nonsense', null), null);
  });

  it('with a password set, a request without it gets a 401 that asks for it and tells crawlers to keep nothing', () => {
    const r = refuseAccess(undefined, 'open-sesame');
    assert.equal(r?.status, 401);
    assert.equal(r?.headers['www-authenticate'], `Basic realm="${ACCESS_REALM}", charset="UTF-8"`);
    assert.equal(r?.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(r?.headers['cache-control'], 'no-store');
    assert.doesNotMatch(r?.body ?? '', /open-sesame/);
  });

  it('refuses a wrong password, a near miss, another scheme and a header it cannot read', () => {
    for (const header of [basic('serif', 'wrong'), basic('serif', 'open-sesam'), basic('serif', 'open-sesame '), basic('open-sesame', ''), 'Bearer open-sesame', 'Basic', 'Basic !!!', `Basic ${Buffer.from('no-colon').toString('base64')}`, 'open-sesame']) {
      assert.equal(refuseAccess(header, 'open-sesame')?.status, 401, header);
    }
  });

  it('lets the right password through, whatever the user name', () => {
    assert.equal(refuseAccess(basic('serif', 'open-sesame'), 'open-sesame'), null);
    assert.equal(refuseAccess(basic('', 'open-sesame'), 'open-sesame'), null);
    assert.equal(refuseAccess(`basic   ${Buffer.from('anyone:open-sesame').toString('base64')}`, 'open-sesame'), null, 'the scheme is not case sensitive');
  });

  it('a protected copy reached over plain http is sent to https before the password is asked for', () => {
    assert.equal(httpsRedirect('http', 'demo.example', '/api/dashboard?x=1', 'pw'), 'https://demo.example/api/dashboard?x=1');
    assert.equal(httpsRedirect('HTTP, https', 'demo.example', '/', 'pw'), 'https://demo.example/', 'the first hop is the visitor');
    assert.equal(httpsRedirect('https', 'demo.example', '/', 'pw'), null);
    assert.equal(httpsRedirect('', '127.0.0.1:3484', '/', 'pw'), null, 'a direct local request is left alone');
    assert.equal(httpsRedirect('http', 'demo.example', '/', null), null, 'with no password there is no gate and no redirect');
    assert.equal(httpsRedirect('http', undefined, '/', 'pw'), null);
  });

  it('reads a password that has a colon or non-ASCII letters in it', () => {
    assert.equal(passwordFrom(basic('u', 'a:b:c')), 'a:b:c');
    assert.equal(refuseAccess(basic('u', 'a:b:c'), 'a:b:c'), null);
    assert.equal(refuseAccess(basic('u', 'señal-ñ'), 'señal-ñ'), null);
  });
});
