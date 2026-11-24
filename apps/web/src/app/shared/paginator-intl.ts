import { Injectable, inject } from '@angular/core';
import { MatPaginatorIntl } from '@angular/material/paginator';
import { TranslocoService } from '@jsverse/transloco';

/** The `paginator.*` texts of the translation file (missing while the language loads). */
type PaginatorTexts = Partial<
  Record<'itemsPerPage' | 'nextPage' | 'previousPage' | 'firstPage' | 'lastPage', string>
>;

/** Angular Material paginator texts from the translation file. */
@Injectable()
export class TranslatedPaginatorIntl extends MatPaginatorIntl {
  /** Translation service. */
  private readonly transloco = inject(TranslocoService);

  /** Applies the `paginator.*` texts whenever the language is loaded or changes. */
  constructor() {
    super();
    // MatPaginatorIntl is a mutable Material API: its fields are set, then `changes` notifies the paginator.
    this.transloco.selectTranslateObject<PaginatorTexts>('paginator').subscribe((t) => {
      this.itemsPerPageLabel = t.itemsPerPage ?? '';
      this.nextPageLabel = t.nextPage ?? '';
      this.previousPageLabel = t.previousPage ?? '';
      this.firstPageLabel = t.firstPage ?? '';
      this.lastPageLabel = t.lastPage ?? '';
      this.changes.next();
    });
  }

  /**
   * Translated "start – end of length" label.
   * @param page Zero-based page index.
   * @param pageSize Page size.
   * @param length Total number of items.
   */
  override getRangeLabel = (page: number, pageSize: number, length: number): string =>
    length === 0
      ? this.transloco.translate('paginator.rangeEmpty', { length })
      : this.transloco.translate('paginator.range', {
          start: page * pageSize + 1,
          end: Math.min((page + 1) * pageSize, length),
          length,
        });
}

/** Provider for pages with a paginator (kept out of the app shell so Material's paginator is lazy-loaded). */
export const provideTranslatedPaginator = () => ({
  provide: MatPaginatorIntl,
  useClass: TranslatedPaginatorIntl,
});
