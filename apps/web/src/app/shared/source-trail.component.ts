import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Finding, SourceTrailEntry } from '../api-client';
import { EnumLabelPipe, IsoDatePipe } from './pipes';

/** Table of the findings behind a procedure group: role, item (with source, channel and reference), type and date. */
@Component({
  selector: 'app-source-trail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTableModule, RouterLink, TranslocoDirective, EnumLabelPipe, IsoDatePipe],
  styles: `
    td.item { width: 55%; }
    .meta a { white-space: nowrap; }
  `,
  template: `
    <table *transloco="let t" mat-table [dataSource]="trail()" class="full stack" data-testid="source-trail">
      <ng-container matColumnDef="role">
        <th mat-header-cell *matHeaderCellDef>{{ t('sourceTrail.role') }}</th>
        <td mat-cell *matCellDef="let e" class="nowrap" [attr.data-label]="t('sourceTrail.role')">{{ e.role | enumLabel: 'role' }}</td>
      </ng-container>
      <ng-container matColumnDef="item">
        <th mat-header-cell *matHeaderCellDef>{{ t('sourceTrail.item') }}</th>
        <td mat-cell *matCellDef="let e" class="item wide">
          <a [routerLink]="['/findings', e.findingId]">{{ e.titleEn ?? e.title }}</a>
          <div class="meta">
            {{ e.externalId }} · {{ e.sourceId }} / {{ e.channel }}
            @if (refs().get(e.findingId); as ref) {
              · {{ t('sourceTrail.ref', { ref }) }}
            }
            @if (e.url) {
              · <a [href]="e.url" target="_blank" rel="noopener">{{ t('sourceTrail.original') }} ↗</a>
            }
          </div>
        </td>
      </ng-container>
      <ng-container matColumnDef="type">
        <th mat-header-cell *matHeaderCellDef>{{ t('sourceTrail.type') }}</th>
        <td mat-cell *matCellDef="let e" [attr.data-label]="t('sourceTrail.type')">
          {{ e.docType | enumLabel: 'docType' }} · {{ e.stage | enumLabel: 'stage' }}
        </td>
      </ng-container>
      <ng-container matColumnDef="language">
        <th mat-header-cell *matHeaderCellDef>{{ t('sourceTrail.language') }}</th>
        <td mat-cell *matCellDef="let e" [attr.data-label]="t('sourceTrail.language')">{{ e.language }}</td>
      </ng-container>
      <ng-container matColumnDef="published">
        <th mat-header-cell *matHeaderCellDef>{{ t('shared.published') }}</th>
        <td mat-cell *matCellDef="let e" class="nowrap" [attr.data-label]="t('shared.published')">{{ e.publishedOn | isoDate }}</td>
      </ng-container>
      <tr mat-header-row *matHeaderRowDef="columns"></tr>
      <tr mat-row *matRowDef="let row; columns: columns"></tr>
    </table>
  `,
})
export class SourceTrailComponent {
  /** Entries of the source trail. */
  readonly trail = input.required<readonly SourceTrailEntry[]>();
  /** Group members in the common schema, when known; adds their procedure reference to the trail. */
  readonly members = input<readonly Finding[]>([]);
  /** Procedure reference per finding id. */
  protected readonly refs = computed(
    () => new Map(this.members().flatMap((m) => (m.ref ? [[m.id, m.ref] as const] : []))),
  );
  /** Displayed table columns. */
  protected readonly columns = ['item', 'role', 'type', 'language', 'published'];
}
