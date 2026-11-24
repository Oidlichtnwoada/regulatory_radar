import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatTableModule } from '@angular/material/table';
import { TranslocoDirective } from '@jsverse/transloco';
import { RadarService } from '../../api-client';
import { ChipComponent } from '../../shared/chip.component';
import { tierChip, verdictChip } from '../../shared/labels';
import { EnumLabelPipe, IsoDatePipe } from '../../shared/pipes';
import { SourceTrailComponent } from '../../shared/source-trail.component';

/** Detail of one procedure group: action points, the source trail of its members, every relevance label and grouping decisions. */
@Component({
  selector: 'app-group-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatTableModule,
    ChipComponent,
    SourceTrailComponent,
    TranslocoDirective,
    EnumLabelPipe,
    IsoDatePipe,
  ],
  styles: `
    .points { display: flex; flex-wrap: wrap; gap: 8px; padding: 0; margin: 0; list-style: none; }
    .points li { padding: 6px 12px; border-radius: 8px; background: var(--mat-sys-surface-container); }
    .points .date { font-weight: 600; margin-right: 6px; }
    .decisions { padding-left: 20px; }
  `,
  template: `
    <ng-container *transloco="let t">
      @if (group.value(); as g) {
        <h2 data-testid="group-title">{{ g.title }}</h2>
        @if (g.titleOriginal && g.titleOriginal !== g.title) {
          <p class="muted">{{ g.language }}: {{ g.titleOriginal }}</p>
        }
        <div class="row">
          <app-chip [spec]="tierChip(g.actionability.tier)" [suffix]="g.actionability.date ? ' · ' + g.actionability.date : ''" />
          <app-chip [spec]="verdictChip(g.verdict)" />
          <span class="muted">
            {{ g.groupKey }} · {{ g.jurisdiction }} · {{ g.stage | enumLabel: 'stage' }} ·
            {{ t('group.firstSeen', { date: g.firstSeenAt | isoDate: true }) }}
          </span>
        </div>
        <p><strong>{{ t('shared.whyRelevant') }}</strong> {{ g.whyRelevant }}</p>
        <h3>{{ t('shared.actionPoints') }}</h3>
        <ul class="points" data-testid="action-points">
          @for (p of g.actionPoints; track p.kind + p.date) {
            <li><span class="date">{{ p.date | isoDate }}</span>{{ p.kind | enumLabel: 'actionPoint' }}</li>
          } @empty {
            <li class="muted">{{ t('group.none') }}</li>
          }
        </ul>
        <h3>{{ t('shared.sourceTrail') }}</h3>
        <app-source-trail [trail]="g.sourceTrail" [members]="g.members" />
        <h3>{{ t('group.relevanceLabels', { engine: g.classificationEngine }) }}</h3>
        <table mat-table [dataSource]="g.labels" class="full stack" data-testid="labels-table">
          <ng-container matColumnDef="country">
            <th mat-header-cell *matHeaderCellDef>{{ t('group.country') }}</th>
            <td mat-cell *matCellDef="let l" class="nowrap" [attr.data-label]="t('group.country')">{{ l.country }}</td>
          </ng-container>
          <ng-container matColumnDef="nace">
            <th mat-header-cell *matHeaderCellDef>{{ t('group.nace') }}</th>
            <td mat-cell *matCellDef="let l" class="nowrap" [attr.data-label]="t('group.nace')">{{ l.naceCode }}</td>
          </ng-container>
          <ng-container matColumnDef="verdict">
            <th mat-header-cell *matHeaderCellDef>{{ t('group.verdict') }}</th>
            <td mat-cell *matCellDef="let l"><app-chip [spec]="verdictChip(l.verdict)" /></td>
          </ng-container>
          <ng-container matColumnDef="rationale">
            <th mat-header-cell *matHeaderCellDef>{{ t('group.rationale') }}</th>
            <td mat-cell *matCellDef="let l" class="wide">{{ l.rationale }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="labelColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: labelColumns"></tr>
        </table>
        <h3>{{ t('group.groupingDecisions') }}</h3>
        <ul class="decisions">
          @for (d of g.groupingDecisions; track d.findingId + d.createdAt) {
            <li>
              {{ t('group.decision', { engine: d.engine, decision: d.decision | enumLabel: 'decision', target: d.targetGroupKey ?? '' }) }}
              – {{ d.rationale }}
            </li>
          } @empty {
            <li class="muted">{{ t('group.deterministicOnly') }}</li>
          }
        </ul>
      } @else if (group.error()) {
        <p role="alert">{{ t('group.notFound') }}</p>
      }
    </ng-container>
  `,
})
export class GroupPage {
  /** Route parameter: the group key. */
  readonly groupKey = input.required<string>();
  /** Radar API. */
  private readonly radarApi = inject(RadarService);
  /** The procedure group. */
  protected readonly group = rxResource({
    params: () => this.groupKey(),
    stream: ({ params }) => this.radarApi.getProcedureGroup(params),
  });
  /** Tier chip lookup. */
  protected readonly tierChip = tierChip;
  /** Verdict chip lookup. */
  protected readonly verdictChip = verdictChip;
  /** Columns of the labels table. */
  protected readonly labelColumns = ['country', 'nace', 'verdict', 'rationale'];
}
