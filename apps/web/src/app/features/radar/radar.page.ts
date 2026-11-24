import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, switchMap } from 'rxjs';
import {
  type OperatorProfile,
  type ProfilePreset,
  ProfileService,
  RadarService,
  TaxonomyService,
  Verdict,
} from '../../api-client';
import { ALL_VERDICTS, listQuery, verdictChip } from '../../shared/labels';
import { NacePickerComponent } from './nace-picker.component';
import { RadarEntryComponent } from './radar-entry.component';

/** Countries and NACE codes chosen by the operator. */
interface Selection {
  /** ISO codes of EU member states. */
  readonly countries: readonly string[];
  /** NACE Rev. 2.1 codes. */
  readonly naceCodes: readonly string[];
}

/**
 * True when the selection equals the saved profile (order-insensitive).
 * @param a Current selection.
 * @param b Saved profile, if loaded.
 */
const sameSelection = (a: Selection, b: Selection | undefined): boolean =>
  !!b &&
  [...a.countries].sort().join() === [...b.countries].sort().join() &&
  [...a.naceCodes].sort().join() === [...b.naceCodes].sort().join();

/** Main page: example profiles, operator selection (persisted in Postgres) and the ranked radar list. */
@Component({
  selector: 'app-radar-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatFormFieldModule,
    MatSelectModule,
    MatChipsModule,
    MatButtonModule,
    MatProgressBarModule,
    MatTooltipModule,
    NacePickerComponent,
    RadarEntryComponent,
    TranslocoDirective,
  ],
  styles: `
    .presets { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .presets .label { font: var(--mat-sys-label-large); margin-right: 4px; }
    .presets .active { background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); }
    .notes { margin: 6px 0 16px; }
    .notes p { margin: 2px 0; }
    .notes .note { margin-top: 8px; padding: 8px 12px; border-radius: 8px; background: var(--mat-sys-surface-container); }
    .selection { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 12px; align-items: start; }
    .selection mat-form-field { width: 100%; }
    .toolbar { margin: 12px 0; }
    @media (max-width: 720px) {
      .selection { grid-template-columns: minmax(0, 1fr); }
    }
  `,
  template: `
    <ng-container *transloco="let t">
      <section class="presets" data-testid="presets">
        <span class="label">{{ t('radar.presets.label') }}</span>
        @for (p of presets.value() ?? []; track p.id) {
          <button
            mat-stroked-button
            [class.active]="activePreset()?.id === p.id"
            [attr.aria-pressed]="activePreset()?.id === p.id"
            [matTooltip]="p.mappingNote"
            [attr.data-testid]="'preset-' + p.id"
            (click)="applyPreset(p)"
          >
            {{ p.label }}
          </button>
        }
      </section>
      <div class="notes meta">
        <p>{{ t('radar.presets.hint') }}</p>
        @if (activePreset(); as p) {
          <p class="note" data-testid="preset-note">
            {{ t(p.exact ? 'radar.presets.noteExact' : 'radar.presets.noteInexact', { label: p.label, codes: p.naceCodesRev2.join(', '), note: p.mappingNote }) }}
          </p>
        }
      </div>
      <section class="selection">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ t('radar.countries') }}</mat-label>
          <mat-select multiple data-testid="country-select" [value]="countries()" (valueChange)="countries.set($event)">
            @for (c of countryOptions.value() ?? []; track c.code) {
              <mat-option [value]="c.code" [attr.data-testid]="'country-option-' + c.code">{{ c.code }} · {{ c.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <app-nace-picker [codes]="naceOptions.value() ?? []" [(selected)]="naceCodes" />
      </section>
      <div class="row toolbar">
        <mat-chip-listbox multiple [attr.aria-label]="t('radar.verdicts')" [value]="verdicts()" (change)="verdicts.set($event.value)">
          @for (v of allVerdicts; track v) {
            <mat-chip-option [value]="v">{{ t(verdictChip(v).labelKey) }}</mat-chip-option>
          }
        </mat-chip-listbox>
        <span class="spacer"></span>
        <button mat-stroked-button (click)="markSeen()" data-testid="mark-seen">{{ t('radar.markSeen') }}</button>
        <a mat-stroked-button [href]="digestUrl()" target="_blank" rel="noopener" data-testid="digest-link">{{ t('radar.digest') }}</a>
      </div>
      @if (radar.isLoading()) {
        <mat-progress-bar mode="indeterminate" />
      }
      @if (radar.error()) {
        <p role="alert">{{ t('radar.loadError') }}</p>
      }
      @if (radar.value(); as r) {
        <p data-testid="denominator">
          <strong>{{ r.total }}</strong>
          {{
            t('radar.denominator', {
              groups: r.groupsChecked,
              findings: r.findingsChecked,
              asOf: r.asOf,
              countries: r.countries.join(', ') || t('radar.noCountry'),
              sectors: r.naceCodes.join(', ') || t('radar.noSector')
            })
          }}
        </p>
        @for (e of r.entries; track e.groupKey) {
          <app-radar-entry [entry]="e" />
        } @empty {
          <p class="muted">{{ t('radar.empty') }}</p>
        }
      }
    </ng-container>
  `,
})
export class RadarPage {
  /** Profile API. */
  private readonly profiles = inject(ProfileService);
  /** Radar API. */
  private readonly radarApi = inject(RadarService);
  /** Taxonomy API. */
  private readonly taxonomy = inject(TaxonomyService);
  /** Saved operator profile. */
  private readonly profile = rxResource({ stream: () => this.profiles.getProfile() });
  /** Example profiles (NACE Rev. 2 codes mapped to Rev. 2.1). */
  protected readonly presets = rxResource({ stream: () => this.profiles.listProfilePresets() });
  /** EU member states for the country select. */
  protected readonly countryOptions = rxResource({ stream: () => this.taxonomy.listCountries() });
  /** Full NACE Rev. 2.1 taxonomy. */
  protected readonly naceOptions = rxResource({ stream: () => this.taxonomy.listNaceCodes() });
  /** Selected countries; starts from the saved profile. */
  protected readonly countries = linkedSignal<readonly string[]>(() => this.profile.value()?.countries ?? []);
  /** Selected NACE codes; starts from the saved profile. */
  protected readonly naceCodes = linkedSignal<readonly string[]>(() => this.profile.value()?.naceCodes ?? []);
  /** Verdicts to show. */
  protected readonly verdicts = signal<readonly Verdict[]>([Verdict.relevant, Verdict.borderline]);
  /** Verdict options. */
  protected readonly allVerdicts = ALL_VERDICTS;
  /** Verdict chip lookup. */
  protected readonly verdictChip = verdictChip;
  /** Current selection as one value. */
  private readonly selection = computed(
    (): Selection => ({ countries: this.countries(), naceCodes: this.naceCodes() }),
  );
  /** The example profile that equals the current selection, if any. */
  protected readonly activePreset = computed(() =>
    this.presets.value()?.find((p) => sameSelection(this.selection(), p)),
  );
  /** Ranked radar for the current selection (the API's order is kept as is). */
  protected readonly radar = rxResource({
    params: () => (this.profile.hasValue() ? { ...this.selection(), verdicts: this.verdicts() } : undefined),
    stream: ({ params }) =>
      this.radarApi.getRadar(
        [...params.countries],
        [...params.naceCodes],
        [...params.verdicts],
        undefined,
        200,
      ),
  });
  /** Link to the e-mail-ready weekly digest for the current selection. */
  protected readonly digestUrl = computed(
    () => `/api/v1/digest/weekly?${listQuery({ countries: this.countries(), naceCodes: this.naceCodes() })}`,
  );

  /** Persists selection changes (debounced) as a new profile version. */
  constructor() {
    toObservable(this.selection)
      .pipe(
        debounceTime(400),
        filter((s) => this.profile.hasValue() && !sameSelection(s, this.profile.value())),
        switchMap((s) => this.save({ ...s, acknowledgedAt: this.profile.value()?.acknowledgedAt ?? null })),
        takeUntilDestroyed(),
      )
      .subscribe((saved) => this.profile.set(saved));
  }

  /**
   * Selects the countries and NACE Rev. 2.1 codes of an example profile, like a manual selection (and persisted the same way).
   * @param preset Example profile.
   */
  protected applyPreset(preset: ProfilePreset): void {
    this.countries.set(preset.countries);
    this.naceCodes.set(preset.naceCodes);
  }

  /** Marks everything currently known as seen, then reloads the radar so NEW badges disappear. */
  protected markSeen(): void {
    this.save({ ...this.selection(), acknowledgedAt: new Date().toISOString() }).subscribe((saved) => {
      this.profile.set(saved);
      this.radar.reload();
    });
  }

  /**
   * Saves a new profile version.
   * @param input Selection and acknowledgement time.
   */
  private save(input: Selection & Pick<OperatorProfile, 'acknowledgedAt'>) {
    return this.profiles.saveProfile({
      ...input,
      countries: [...input.countries],
      naceCodes: [...input.naceCodes],
    });
  }
}
