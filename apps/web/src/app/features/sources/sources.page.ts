import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { TranslocoDirective } from '@jsverse/transloco';
import { SourcesService, SystemService } from '../../api-client';
import { ChipComponent } from '../../shared/chip.component';
import { filterEntries, healthChip } from '../../shared/labels';
import { EnumLabelPipe, IsoDatePipe } from '../../shared/pipes';
import { polled } from '../../shared/poll';

/** Per-source status (ok / degraded / failed, counts, last fetch, watermark) and pipeline progress; refreshed every 10 s. */
@Component({
  selector: 'app-sources-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTableModule, ChipComponent, TranslocoDirective, EnumLabelPipe, IsoDatePipe],
  styles: `
    td.source { min-width: 200px; }
    td.filters { max-width: 280px; }
    td.run { min-width: 230px; }
    .tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag .unset { color: var(--mat-sys-on-surface-variant); font-style: italic; }
  `,
  template: `
    <ng-container *transloco="let t">
      <h2>{{ t('pages.sources') }}</h2>
      <table mat-table [dataSource]="sources.value() ?? []" class="full stack" data-testid="sources-table">
        <ng-container matColumnDef="source">
          <th mat-header-cell *matHeaderCellDef>{{ t('shared.source') }}</th>
          <td mat-cell *matCellDef="let s" class="source wide">
            <strong>{{ s.name }}</strong>
            <div class="meta">
              {{ s.id }} · {{ s.kind | enumLabel: 'sourceKind' }} · {{ s.level | enumLabel: 'level' }} {{ s.country ?? '' }} ·
              {{ t(s.requiresNetwork ? 'sources.network' : 'sources.offline') }}
            </div>
          </td>
        </ng-container>
        <ng-container matColumnDef="health">
          <th mat-header-cell *matHeaderCellDef>{{ t('sources.health') }}</th>
          <td mat-cell *matCellDef="let s"><app-chip [spec]="healthChip(s.health)" [testId]="'health-' + s.id" /></td>
        </ng-container>
        <ng-container matColumnDef="records">
          <th mat-header-cell *matHeaderCellDef>{{ t('sources.records') }}</th>
          <td mat-cell *matCellDef="let s" [attr.data-label]="t('sources.records')" [attr.data-testid]="'records-' + s.id">{{ s.recordCount }}</td>
        </ng-container>
        <ng-container matColumnDef="watermark">
          <th mat-header-cell *matHeaderCellDef>{{ t('sources.watermark') }}</th>
          <td mat-cell *matCellDef="let s" class="nowrap" [attr.data-label]="t('sources.watermark')">{{ (s.watermark | isoDate) || '–' }}</td>
        </ng-container>
        <ng-container matColumnDef="lastRun">
          <th mat-header-cell *matHeaderCellDef>{{ t('sources.lastFetch') }}</th>
          <td mat-cell *matCellDef="let s" class="run wide" [attr.data-label]="t('sources.lastFetch')">
            @if (s.lastRun; as r) {
              {{ r.at | isoDate: true }}
              <span class="meta sub">
                {{ t('sources.lastRun', { fetched: r.fetched, inserted: r.inserted, duplicates: r.duplicates }) }}
                @if (r.durationMs !== null && r.durationMs !== undefined) {
                  · {{ t('sources.durationMs', { ms: r.durationMs }) }}
                }
              </span>
              @if (r.message) {
                <div class="meta">{{ r.message }}</div>
              }
            } @else {
              {{ t('sources.never') }}
            }
          </td>
        </ng-container>
        <ng-container matColumnDef="filters">
          <th mat-header-cell *matHeaderCellDef>{{ t('sources.filters') }}</th>
          <td mat-cell *matCellDef="let s" class="filters wide">
            <div class="tags" [attr.data-testid]="'filters-' + s.id">
              @for (f of filterEntries(s.filters); track f.key) {
                <span class="tag">
                  {{ f.key }}:
                  @if (f.value) {
                    {{ f.value }}
                  } @else {
                    <span class="unset">{{ t('sources.notSet') }}</span>
                  }
                </span>
              }
            </div>
          </td>
        </ng-container>
        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns" [attr.data-testid]="'source-row-' + row.id"></tr>
      </table>
      @if (pipeline.value(); as p) {
        <h2>{{ t('sources.pipeline.title') }}</h2>
        <dl class="fields" data-testid="pipeline-status">
          <dt>{{ t('shared.findings') }}</dt><dd>{{ p.findings }}</dd>
          <dt>{{ t('sources.pipeline.translation', { engine: p.engines.translation }) }}</dt>
          <dd>{{ t('sources.pipeline.progress', p.translations) }}</dd>
          <dt>{{ t('sources.pipeline.embedding', { engine: p.engines.embedding }) }}</dt>
          <dd>{{ t('sources.pipeline.progress', p.embeddings) }}</dd>
          <dt>{{ t('sources.pipeline.naceEmbedding', { engine: p.engines.embedding }) }}</dt>
          <dd>{{ t('sources.pipeline.naceProgress', p.naceEmbeddings) }}</dd>
          <dt>{{ t('sources.pipeline.grouping', { engine: p.engines.grouping }) }}</dt>
          <dd>{{ t('sources.pipeline.groups', { count: p.groups }) }}</dd>
          <dt>{{ t('sources.pipeline.classification', { engine: p.engines.classification }) }}</dt>
          <dd>{{ t('sources.pipeline.classified', { count: p.classifiedGroups }) }}</dd>
          <dt>{{ t('sources.pipeline.lastCycle') }}</dt><dd>{{ (p.lastCycleAt | isoDate: true) || '–' }}</dd>
        </dl>
      }
    </ng-container>
  `,
})
export class SourcesPage {
  /** Sources API. */
  private readonly sourcesApi = inject(SourcesService);
  /** System API. */
  private readonly system = inject(SystemService);
  /** Source statuses, polled. */
  protected readonly sources = polled(() => this.sourcesApi.listSources(), 10_000);
  /** Pipeline counters, polled. */
  protected readonly pipeline = polled(() => this.system.getPipelineStatus(), 10_000);
  /** Health chip lookup. */
  protected readonly healthChip = healthChip;
  /** Source filters as key/value text. */
  protected readonly filterEntries = filterEntries;
  /** Displayed columns. */
  protected readonly columns = ['source', 'health', 'records', 'watermark', 'lastRun', 'filters'];
}
