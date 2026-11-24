import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';
import { MatAutocompleteModule, type MatAutocompleteSelectedEvent } from '@angular/material/autocomplete';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslocoDirective } from '@jsverse/transloco';
import type { NaceCode } from '../../api-client';
import { searchNace } from '../../shared/labels';

/** Searchable multi-select over the complete NACE Rev. 2.1 taxonomy (code or title search, chips for the selection). */
@Component({
  selector: 'app-nace-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatFormFieldModule, MatInputModule, MatChipsModule, MatAutocompleteModule, TranslocoDirective],
  styles: `
    :host { display: block; }
    mat-form-field { width: 100%; }
    input { flex: 1 0 220px; }
    .opt-code { font-weight: 600; margin-right: 6px; }
  `,
  template: `
    <mat-form-field *transloco="let t" appearance="outline" subscriptSizing="dynamic">
      <mat-label>{{ t('radar.nace.label') }}</mat-label>
      <mat-chip-grid #grid [attr.aria-label]="t('radar.nace.selected')">
        @for (code of selected(); track code) {
          <mat-chip-row (removed)="remove(code)" [attr.data-testid]="'nace-chip-' + code">
            {{ code }}
            <button matChipRemove [attr.aria-label]="t('radar.nace.remove', { code })">×</button>
          </mat-chip-row>
        }
        <input
          data-testid="nace-input"
          [placeholder]="t('radar.nace.placeholder')"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
          [matChipInputFor]="grid"
          [matAutocomplete]="auto"
        />
      </mat-chip-grid>
      <mat-autocomplete #auto="matAutocomplete" (optionSelected)="add($event)">
        @for (c of options(); track c.code) {
          <mat-option [value]="c.code" [style.padding-left.px]="16 + c.depth * 16" [attr.data-testid]="'nace-option-' + c.code">
            <span class="opt-code">{{ c.code }}</span>{{ c.title }}
          </mat-option>
        }
      </mat-autocomplete>
    </mat-form-field>
  `,
})
export class NacePickerComponent {
  /** The full taxonomy. */
  readonly codes = input.required<readonly NaceCode[]>();
  /** Selected codes (two-way bound). */
  readonly selected = model.required<readonly string[]>();
  /** Current search text. */
  protected readonly query = signal('');
  /** Options matching the search, without the selected ones. */
  protected readonly options = computed(() => searchNace(this.codes(), this.query(), this.selected()));

  /**
   * Adds the chosen option to the selection and clears the search.
   * @param event Autocomplete selection event.
   */
  protected add(event: MatAutocompleteSelectedEvent): void {
    this.selected.update((codes) => [...codes, event.option.value as string]);
    this.query.set('');
    event.option.deselect();
  }

  /**
   * Removes a code from the selection.
   * @param code NACE code to remove.
   */
  protected remove(code: string): void {
    this.selected.update((codes) => codes.filter((c) => c !== code));
  }
}
