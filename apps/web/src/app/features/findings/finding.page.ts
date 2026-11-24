import { JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { FindingsService } from '../../api-client';
import { EnumLabelPipe, IsoDatePipe } from '../../shared/pipes';

/** One finding: common-schema fields, translation and embedding status, and the raw source payload. */
@Component({
  selector: 'app-finding-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JsonPipe, RouterLink, TranslocoDirective, EnumLabelPipe, IsoDatePipe],
  template: `
    <ng-container *transloco="let t">
      @if (finding.value(); as f) {
        <h2>{{ f.title }}</h2>
        <dl class="fields" data-testid="finding-fields">
          <dt>{{ t('shared.source') }}</dt><dd>{{ f.sourceId }} / {{ f.channel }} / {{ f.externalId }}</dd>
          <dt>{{ t('shared.jurisdiction') }}</dt><dd>{{ f.jurisdiction }} ({{ f.level | enumLabel: 'level' }})</dd>
          <dt>{{ t('shared.language') }}</dt><dd>{{ f.language }}</dd>
          <dt>{{ t('finding.typeStage') }}</dt><dd>{{ f.docType | enumLabel: 'docType' }} · {{ f.stage | enumLabel: 'stage' }}</dd>
          <dt>{{ t('shared.published') }}</dt><dd>{{ f.publishedOn | isoDate }}</dd>
          <dt>{{ t('shared.deadline') }}</dt><dd>{{ (f.deadline | isoDate) || '–' }} {{ f.deadlineKind ? '(' + (f.deadlineKind | enumLabel: 'deadlineKind') + ')' : '' }}</dd>
          <dt>{{ t('finding.event') }}</dt><dd>{{ (f.eventDate | isoDate) || '–' }}</dd>
          <dt>{{ t('finding.reference') }}</dt><dd>{{ f.ref ?? '–' }} {{ f.relatedTo ? t('finding.relatedTo', { ref: f.relatedTo }) : '' }}</dd>
          <dt>{{ t('shared.naceTags') }}</dt><dd>{{ f.naceTagsStated ? f.naceTags.join(', ') || t('finding.notSectorSpecific') : t('finding.notGiven') }}</dd>
          <dt>{{ t('finding.topics') }}</dt><dd>{{ f.topics.join(', ') }}</dd>
          <dt>{{ t('finding.summary') }}</dt><dd>{{ f.summary ?? '–' }}</dd>
          <dt>{{ t('finding.titleEn') }}</dt><dd>{{ f.translation.titleEn ?? '–' }} ({{ f.translation.status | enumLabel: 'translation' }}, {{ f.translation.engine ?? t('shared.notAvailable') }})</dd>
          <dt>{{ t('finding.summaryEn') }}</dt><dd>{{ f.translation.summaryEn ?? '–' }}</dd>
          <dt>{{ t('finding.embedding') }}</dt><dd>
            @if (f.embedding.dimensions) {
              {{ t('finding.embeddingInfo', { status: f.embedding.status | enumLabel: 'embedding', engine: f.embedding.engine, dimensions: f.embedding.dimensions }) }}
            } @else {
              {{ f.embedding.status | enumLabel: 'embedding' }}
            }
          </dd>
          <dt>{{ t('finding.group') }}</dt>
          <dd>
            @if (f.groupKey) {
              <a [routerLink]="['/groups', f.groupKey]">{{ f.groupKey }}</a>
            } @else {
              –
            }
          </dd>
          <dt>{{ t('finding.link') }}</dt>
          <dd>
            @if (f.url) {
              <a [href]="f.url" target="_blank" rel="noopener">{{ f.url }}</a>
            } @else {
              –
            }
          </dd>
        </dl>
        <h3>{{ t('shared.actionPoints') }}</h3>
        <ul data-testid="finding-action-points">
          @for (p of f.actionPoints; track p.kind + p.date) {
            <li><strong>{{ p.date | isoDate }}</strong> · {{ p.kind | enumLabel: 'actionPoint' }}</li>
          } @empty {
            <li class="muted">{{ t('group.none') }}</li>
          }
        </ul>
        <h3>{{ t('finding.attributes') }}</h3>
        <pre class="json">{{ f.attributes | json }}</pre>
        <h3>{{ t('finding.raw') }}</h3>
        <pre class="json" data-testid="raw-payload">{{ f.raw | json }}</pre>
      } @else if (finding.error()) {
        <p role="alert">{{ t('finding.notFound') }}</p>
      }
    </ng-container>
  `,
})
export class FindingPage {
  /** Route parameter: finding id. */
  readonly id = input.required<string>();
  /** Findings API. */
  private readonly findings = inject(FindingsService);
  /** The finding. */
  protected readonly finding = rxResource({
    params: () => this.id(),
    stream: ({ params }) => this.findings.getFinding(params),
  });
}
