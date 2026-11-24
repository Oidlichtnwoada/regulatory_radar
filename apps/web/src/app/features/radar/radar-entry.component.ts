import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { RadarEntry } from '../../api-client';
import { ChipComponent } from '../../shared/chip.component';
import { tierChip, verdictChip } from '../../shared/labels';
import { EnumLabelPipe } from '../../shared/pipes';
import { SourceTrailComponent } from '../../shared/source-trail.component';

/** One ranked procedure group: title, urgency, verdict, why relevant and the expandable source trail. */
@Component({
  selector: 'app-radar-entry',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatExpansionModule,
    RouterLink,
    ChipComponent,
    SourceTrailComponent,
    TranslocoDirective,
    EnumLabelPipe,
  ],
  styles: `
    mat-card { margin-bottom: 12px; }
    .title { font: var(--mat-sys-title-medium); margin: 4px 0; }
    .why { margin: 8px 0; }
    .labels { margin-bottom: 8px; }
    mat-expansion-panel { box-shadow: none; border: 1px solid var(--mat-sys-outline-variant); }
    .new { background: var(--mat-sys-tertiary); color: var(--mat-sys-on-tertiary); }
  `,
  template: `
    <mat-card *transloco="let t" appearance="outlined" data-testid="radar-entry" [attr.data-tier]="entry().actionability.tier">
      <mat-card-content>
        <div class="row">
          <app-chip
            [spec]="tierChip(entry().actionability.tier)"
            [suffix]="entry().actionability.date ? ' · ' + entry().actionability.date : ''"
            testId="tier-chip"
          />
          <app-chip [spec]="verdictChip(entry().verdict)" testId="verdict-chip" />
          @if (entry().isNew) {
            <span class="tone new" data-testid="new-badge">{{ t('radar.entry.new') }}</span>
          }
          <span class="muted">{{ entry().jurisdiction }} · {{ entry().stage | enumLabel: 'stage' }} · {{ t('radar.entry.items', { count: entry().memberCount }) }}</span>
        </div>
        <div class="title" data-testid="entry-title">
          <a [routerLink]="['/groups', entry().groupKey]">{{ entry().title }}</a>
        </div>
        @if (entry().titleOriginal && entry().titleOriginal !== entry().title) {
          <div class="muted">{{ entry().language }}: {{ entry().titleOriginal }}</div>
        }
        <div class="why" data-testid="why-relevant"><strong>{{ t('shared.whyRelevant') }}</strong> {{ entry().whyRelevant }}</div>
        <div class="meta labels">
          {{ t('radar.entry.labels') }}
          @for (l of entry().matchedLabels; track l.country + l.naceCode) {
            <span>{{ l.country }}×{{ l.naceCode }} ({{ l.verdict | enumLabel: 'verdict' }}) </span>
          }
          · {{ t('radar.entry.engine', { engine: entry().classificationEngine }) }}
        </div>
        <mat-expansion-panel>
          <mat-expansion-panel-header>{{ t('shared.sourceTrail') }} ({{ entry().sourceTrail.length }})</mat-expansion-panel-header>
          @defer (on viewport) {
            <app-source-trail [trail]="entry().sourceTrail" />
          } @placeholder {
            <span>…</span>
          }
        </mat-expansion-panel>
      </mat-card-content>
    </mat-card>
  `,
})
export class RadarEntryComponent {
  /** The radar entry to render. */
  readonly entry = input.required<RadarEntry>();
  /** Tier chip lookup. */
  protected readonly tierChip = tierChip;
  /** Verdict chip lookup. */
  protected readonly verdictChip = verdictChip;
}
