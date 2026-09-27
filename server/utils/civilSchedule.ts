/** Earliest occurrence of a local wall time strictly after `now` in an IANA zone. */
export function nextCivilDaily(now: number, timeZone: string, dailyAt: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyAt)) throw new Error('Daily time must be HH:mm');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch { throw new Error('Valid IANA time zone required'); }
  const fields = (timestamp: number) => Object.fromEntries(formatter.formatToParts(timestamp)
    .filter(part => ['year', 'month', 'day', 'hour', 'minute'].includes(part.type))
    .map(part => [part.type, Number(part.value)])) as Record<'year' | 'month' | 'day' | 'hour' | 'minute', number>;
  const current = fields(now);
  const [hour, minute] = dailyAt.split(':').map(Number);
  // Scan an offset-bounded UTC window per local date. An ambiguous fall-back
  // wall time chooses its *first* occurrence; a nonexistent spring-forward
  // time skips that civil date. Neither creates a second daily input.
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const day = new Date(Date.UTC(current.year, current.month - 1, current.day + dayOffset));
    const year = day.getUTCFullYear(), month = day.getUTCMonth() + 1, date = day.getUTCDate();
    const naive = Date.UTC(year, month - 1, date, hour, minute);
    for (let candidate = naive - 14 * 3_600_000; candidate <= naive + 12 * 3_600_000; candidate += 60_000) {
      const local = fields(candidate);
      if (local.year === year && local.month === month && local.day === date &&
          local.hour === hour && local.minute === minute) {
        if (candidate > now) return new Date(candidate).toISOString();
        break;
      }
    }
  }
  throw new Error('No civil-time occurrence within seven days');
}
