import { TestBed } from '@angular/core/testing';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import enUS from '../../i18n/en-US.json';
import { DEFAULT_LANG } from './i18n';
import { EnumLabelPipe, IsoDatePipe } from './pipes';

describe('pipes', () => {
  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: { [DEFAULT_LANG]: enUS },
          translocoConfig: { availableLangs: [DEFAULT_LANG], defaultLang: DEFAULT_LANG },
        }),
      ],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load(DEFAULT_LANG));
  });

  it('enumLabel translates known values and humanises unknown docTypes', () => {
    const pipe = TestBed.runInInjectionContext(() => new EnumLabelPipe());
    expect(pipe.transform('consultation_open', 'stage')).toBe('Consultation open');
    expect(pipe.transform('ministerial_draft', 'docType')).toBe('Ministerial draft');
    expect(pipe.transform('framework_directive', 'docType')).toBe('Framework directive');
    expect(pipe.transform(null, 'stage')).toBe('');
  });

  it('isoDate keeps calendar dates and shows timestamps in the browser time zone with its label', () => {
    const pipe = TestBed.runInInjectionContext(() => new IsoDatePipe());
    const instant = '2026-11-24T19:55:47.363Z';
    const local = new Date(instant);
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
    expect(pipe.transform('2026-11-24')).toBe('2026-11-24');
    expect(pipe.transform(instant)).toBe(day);
    expect(pipe.transform(instant, true)).toMatch(
      new RegExp(`^${day} ${pad(local.getHours())}:${pad(local.getMinutes())} (GMT|UTC)`),
    );
    expect(pipe.transform(undefined)).toBe('');
  });
});
