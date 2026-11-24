import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChipSpec } from './labels';

/** One status chip (tier, verdict, health); the single place chip markup lives. */
@Component({
  selector: 'app-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `<span class="tone tone-{{ spec().tone }}" [attr.data-testid]="testId()">{{ spec().labelKey | transloco }}{{ suffix() }}</span>`,
})
export class ChipComponent {
  /** Label key and tone. */
  readonly spec = input.required<ChipSpec>();
  /** Optional text appended to the label (e.g. a date). */
  readonly suffix = input('');
  /** Optional data-testid of the chip. */
  readonly testId = input<string | null>(null);
}
