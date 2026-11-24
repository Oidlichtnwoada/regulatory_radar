import { DatePipe } from '@angular/common';
import { inject, LOCALE_ID, Pipe, type PipeTransform } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { humanise, type LabelGroup, labelKey } from './labels';

/** ISO 8601 calendar date (the one date format of the UI). */
export const DATE_FORMAT = 'yyyy-MM-dd';
/** Date and time in the browser's time zone, with the zone's short name (e.g. 2026-11-24 22:18 GMT+1). */
export const DATE_TIME_FORMAT = 'yyyy-MM-dd HH:mm z';
/** A calendar date without time (publication day, deadline, watermark): shown as is, it has no time zone. */
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Formats API dates consistently. Calendar dates stay as they are (`2026-11-24`). Timestamps are shown in the
 * browser's time zone: as the local day, or with `withTime` as local date, time and zone (`2026-11-24 22:18 GMT+1`).
 * Empty input gives an empty string.
 */
@Pipe({ name: 'isoDate' })
export class IsoDatePipe implements PipeTransform {
  /** Angular's date pipe with the app locale; without a zone argument it uses the browser's time zone. */
  private readonly date = new DatePipe(inject(LOCALE_ID));

  /**
   * Formatted date.
   * @param value ISO date or date-time from the API.
   * @param withTime Show the local time and time zone as well.
   */
  transform(value: string | null | undefined, withTime = false): string {
    if (!value) return '';
    if (PLAIN_DATE.test(value)) return value;
    return this.date.transform(value, withTime ? DATE_TIME_FORMAT : DATE_FORMAT) ?? '';
  }
}

/** Readable, translated label of a raw API enum value (`labels.<group>.<value>`), humanised when no key exists. */
@Pipe({ name: 'enumLabel' })
export class EnumLabelPipe implements PipeTransform {
  /** Translation service. */
  private readonly transloco = inject(TranslocoService);

  /**
   * Label text.
   * @param value Raw API value.
   * @param group Label group of the value.
   */
  transform(value: string | null | undefined, group: LabelGroup): string {
    if (!value) return '';
    const text = this.transloco.getTranslation(this.transloco.getActiveLang())[labelKey(group, value)];
    return typeof text === 'string' ? text : humanise(value);
  }
}
