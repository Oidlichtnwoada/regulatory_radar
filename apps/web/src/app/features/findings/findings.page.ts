import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime } from 'rxjs';
import { FindingsService, SourcesService, TaxonomyService } from '../../api-client';
import { provideTranslatedPaginator } from '../../shared/paginator-intl';
import { EnumLabelPipe, IsoDatePipe } from '../../shared/pipes';

/** Raw imports: every finding in the common schema, newest first, filterable and paginated. */
@Component({
  providers: [provideTranslatedPaginator()],
  selector: 'app-findings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTableModule,
    MatPaginatorModule,
    RouterLink,
    TranslocoDirective,
    EnumLabelPipe,
    IsoDatePipe,
  ],
  styles: `
    td.title { min-width: 280px; }
    td.title .meta { margin-top: 2px; }
  `,
  template: `
    <ng-container *transloco="let t">
      <section class="filters">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ t('findings.search') }}</mat-label>
          <input matInput data-testid="findings-search" [value]="query()" (input)="query.set($any($event.target).value)" />
        </mat-form-field>
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ t('shared.jurisdiction') }}</mat-label>
          <mat-select multiple [value]="countries()" (valueChange)="countries.set($event); pageIndex.set(0)">
            <mat-option value="EU">EU</mat-option>
            @for (c of countryOptions.value() ?? []; track c.code) {
              <mat-option [value]="c.code">{{ c.code }} · {{ c.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ t('shared.source') }}</mat-label>
          <mat-select multiple [value]="sourceIds()" (valueChange)="sourceIds.set($event); pageIndex.set(0)">
            @for (s of sources.value() ?? []; track s.id) {
              <mat-option [value]="s.id">{{ s.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </section>
      @if (page.value(); as p) {
        <p class="muted" data-testid="findings-total">{{ t('findings.total', { count: p.total }) }}</p>
        <table mat-table [dataSource]="p.items" class="full stack" data-testid="findings-table">
          <ng-container matColumnDef="title">
            <th mat-header-cell *matHeaderCellDef>{{ t('findings.columns.title') }}</th>
            <td mat-cell class="title wide" *matCellDef="let f">
              <a [routerLink]="['/findings', f.id]">{{ f.title }}</a>
              @if (f.translation.titleEn && f.translation.titleEn !== f.title) {
                <div class="muted">{{ f.translation.titleEn }}</div>
              }
              <div class="meta">
                {{ f.sourceId }} · {{ f.externalId }}
                @if (f.ref && f.ref !== f.externalId) {
                  · {{ t('findings.ref', { ref: f.ref }) }}
                }
              </div>
            </td>
          </ng-container>
          <ng-container matColumnDef="origin">
            <th mat-header-cell *matHeaderCellDef>{{ t('findings.columns.origin') }}</th>
            <td mat-cell class="nowrap" *matCellDef="let f">{{ f.jurisdiction }} · {{ f.language }}</td>
          </ng-container>
          <ng-container matColumnDef="type">
            <th mat-header-cell *matHeaderCellDef>{{ t('findings.columns.type') }}</th>
            <td mat-cell *matCellDef="let f">
              {{ f.docType | enumLabel: 'docType' }}
              <span class="meta sub">{{ f.stage | enumLabel: 'stage' }}</span>
            </td>
          </ng-container>
          <ng-container matColumnDef="dates">
            <th mat-header-cell *matHeaderCellDef>{{ t('findings.columns.dates') }}</th>
            <td mat-cell class="nowrap" *matCellDef="let f">
              {{ f.publishedOn | isoDate }}
              @if (f.deadline) {
                <span class="meta sub">{{ t('findings.deadline', { date: f.deadline | isoDate }) }}</span>
              }
            </td>
          </ng-container>
          <ng-container matColumnDef="nace">
            <th mat-header-cell *matHeaderCellDef>{{ t('shared.naceTags') }}</th>
            <td mat-cell *matCellDef="let f" [attr.data-label]="t('shared.naceTags')">
              {{ f.naceTagsStated ? f.naceTags.join(', ') || t('finding.notSectorSpecific') : '–' }}
            </td>
          </ng-container>
          <ng-container matColumnDef="translation">
            <th mat-header-cell *matHeaderCellDef>{{ t('findings.columns.translation') }}</th>
            <td mat-cell *matCellDef="let f" [attr.data-label]="t('findings.columns.translation')">
              {{ f.translation.status | enumLabel: 'translation' }}
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="columns"></tr>
          <tr mat-row data-testid="finding-row" *matRowDef="let row; columns: columns"></tr>
        </table>
        <mat-paginator
          [length]="p.total"
          [pageIndex]="pageIndex()"
          [pageSize]="pageSize()"
          [pageSizeOptions]="[25, 50, 100, 200]"
          (page)="onPage($event)"
        />
      }
    </ng-container>
  `,
})
export class FindingsPage {
  /** Findings API. */
  private readonly findings = inject(FindingsService);
  /** Taxonomy API. */
  private readonly taxonomy = inject(TaxonomyService);
  /** Sources API. */
  private readonly sourcesApi = inject(SourcesService);
  /** EU member states for the jurisdiction filter. */
  protected readonly countryOptions = rxResource({ stream: () => this.taxonomy.listCountries() });
  /** Configured sources for the source filter. */
  protected readonly sources = rxResource({ stream: () => this.sourcesApi.listSources() });
  /** Search text as typed. */
  protected readonly query = signal('');
  /** Search text, debounced. */
  private readonly debouncedQuery = toSignal(toObservable(this.query).pipe(debounceTime(300)), {
    initialValue: '',
  });
  /** Jurisdiction filter. */
  protected readonly countries = signal<string[]>([]);
  /** Source filter. */
  protected readonly sourceIds = signal<string[]>([]);
  /** Current page index. */
  protected readonly pageIndex = signal(0);
  /** Current page size. */
  protected readonly pageSize = signal(50);
  /** Displayed columns: the title first, compact secondary fields after it. */
  protected readonly columns = ['title', 'origin', 'type', 'dates', 'nace', 'translation'];
  /** Current page of findings. */
  protected readonly page = rxResource({
    params: () => ({
      q: this.debouncedQuery(),
      countries: this.countries(),
      sourceIds: this.sourceIds(),
      index: this.pageIndex(),
      size: this.pageSize(),
    }),
    stream: ({ params: p }) =>
      this.findings.listFindings(p.countries, p.sourceIds, p.q || undefined, p.size, p.index * p.size),
  });

  /** Resets to the first page whenever the search text changes. */
  constructor() {
    toObservable(this.debouncedQuery)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.pageIndex.set(0));
  }

  /**
   * Applies a paginator change.
   * @param event Paginator event.
   */
  protected onPage(event: PageEvent): void {
    this.pageIndex.set(event.pageIndex);
    this.pageSize.set(event.pageSize);
  }
}
