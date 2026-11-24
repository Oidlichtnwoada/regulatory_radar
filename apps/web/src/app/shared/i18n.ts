import {
  type EnvironmentProviders,
  Injectable,
  inject,
  isDevMode,
  LOCALE_ID,
  type Provider,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { type RouterStateSnapshot, TitleStrategy } from '@angular/router';
import {
  provideTransloco,
  type Translation,
  type TranslocoLoader,
  TranslocoService,
} from '@jsverse/transloco';
import { take } from 'rxjs';

/** Bundled translation files; adding a language is one JSON file in `src/i18n` plus one entry here. */
const TRANSLATIONS: Readonly<Record<string, () => Promise<{ default: Translation }>>> = {
  'en-US': () => import('../../i18n/en-US.json'),
};

/** Default language, also used as the locale of Angular's date and number pipes. */
export const DEFAULT_LANG = 'en-US';

/** Loads translations via dynamic `import()`: bundled, no HTTP, works unchanged in unit tests. */
@Injectable({ providedIn: 'root' })
class BundledLoader implements TranslocoLoader {
  /**
   * Translation of one language.
   * @param lang Language code.
   */
  getTranslation(lang: string): Promise<Translation> {
    return TRANSLATIONS[lang]().then((m) => m.default);
  }
}

/** Treats route titles as translation keys. */
@Injectable({ providedIn: 'root' })
class TranslatedTitleStrategy extends TitleStrategy {
  /** Document title service. */
  private readonly title = inject(Title);
  /** Translation service. */
  private readonly transloco = inject(TranslocoService);

  /**
   * Sets the translated title of the activated route.
   * @param snapshot Router state after navigation.
   */
  override updateTitle(snapshot: RouterStateSnapshot): void {
    const key = this.buildTitle(snapshot);
    if (key) {
      this.transloco
        .selectTranslate<string>(key)
        .pipe(take(1))
        .subscribe((text) => this.title.setTitle(text));
    }
  }
}

/** Transloco (missing keys are logged in dev mode), the matching LOCALE_ID and translated route titles. */
export const provideI18n = (): (Provider | EnvironmentProviders)[] => [
  provideTransloco({
    config: {
      availableLangs: Object.keys(TRANSLATIONS),
      defaultLang: DEFAULT_LANG,
      fallbackLang: DEFAULT_LANG,
      reRenderOnLangChange: true,
      prodMode: !isDevMode(),
      missingHandler: { logMissingKey: true },
    },
    loader: BundledLoader,
  }),
  { provide: LOCALE_ID, useValue: DEFAULT_LANG },
  { provide: TitleStrategy, useClass: TranslatedTitleStrategy },
];
