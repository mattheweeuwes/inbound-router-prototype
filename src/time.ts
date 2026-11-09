// Eastern-time helpers: business-hours SLA math without a tz library.

const TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});

export interface EtParts { y: number; mo: number; d: number; h: number; mi: number; dow: number } // dow 0=Sun

export function etParts(t: Date | number): EtParts {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, dow };
}

/** Wall-clock ET fields -> UTC epoch ms. Two-pass so it is right across DST changes. */
function etWallToUtc(y: number, mo: number, d: number, h: number, mi: number): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc + 5 * 3600_000;
  for (let i = 0; i < 2; i++) {
    const p = etParts(guess);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += asUtc - shown;
  }
  return guess;
}

export const BIZ_OPEN_H = 9;
export const BIZ_CLOSE_H = 18;

export function isBusinessTime(t: Date | number): boolean {
  const p = etParts(t);
  return p.dow >= 1 && p.dow <= 5 && p.h >= BIZ_OPEN_H && p.h < BIZ_CLOSE_H;
}

/** First business-open instant at or after t (t itself if already inside business hours). */
export function nextBusinessOpen(t: Date | number): number {
  if (isBusinessTime(t)) return +t;
  let p = etParts(t);
  if (p.dow >= 1 && p.dow <= 5 && p.h < BIZ_OPEN_H) return etWallToUtc(p.y, p.mo, p.d, BIZ_OPEN_H, 0);
  for (let i = 0; i < 8; i++) {
    const noonNextDay = etWallToUtc(p.y, p.mo, p.d, 12, 0) + 24 * 3600_000;
    p = etParts(noonNextDay);
    if (p.dow >= 1 && p.dow <= 5) return etWallToUtc(p.y, p.mo, p.d, BIZ_OPEN_H, 0);
  }
  return +t;
}

/** Add business minutes (Mon-Fri 09:00-18:00 ET). After hours rolls to the next business morning. */
export function addBusinessMinutes(t: Date | number, minutes: number): number {
  let ms = nextBusinessOpen(t);
  let left = minutes;
  while (left > 0) {
    const p = etParts(ms);
    const closeMs = etWallToUtc(p.y, p.mo, p.d, BIZ_CLOSE_H, 0);
    const avail = Math.floor((closeMs - ms) / 60_000);
    if (left <= avail) return ms + left * 60_000;
    left -= avail;
    ms = nextBusinessOpen(closeMs);
  }
  return ms;
}

export const iso = (ms: number) => new Date(ms).toISOString();
