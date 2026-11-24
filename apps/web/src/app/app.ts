import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { SystemService } from './api-client';
import { EnumLabelPipe } from './shared/pipes';
import { polled } from './shared/poll';

/** Application shell: navigation plus the persistent offline / missing-API-key warning banner. */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule, TranslocoDirective, EnumLabelPipe],
  styles: `
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 16px;
      padding: 8px 16px;
      background: var(--mat-sys-surface-container);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .brand { font: var(--mat-sys-title-large); color: inherit; text-decoration: none; white-space: nowrap; }
    nav { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
    .active { background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); }
    .status { font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant); }
    .banner { background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); }
    .banner p { max-width: 1200px; margin: 0 auto; padding: 8px 16px; box-sizing: border-box; }
    .banner p + p { padding-top: 0; }
    @media (max-width: 720px) {
      .brand { flex: 1; }
      nav { order: 3; flex-basis: 100%; margin: 0 -8px; }
      .status { order: 4; flex-basis: 100%; }
    }
  `,
  template: `
    <ng-container *transloco="let t">
      <header>
        <a class="brand" routerLink="/">{{ t('app.name') }}</a>
        <nav [attr.aria-label]="t('app.nav')">
          <a mat-button routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">{{ t('pages.radar') }}</a>
          <a mat-button routerLink="/findings" routerLinkActive="active" data-testid="nav-findings">{{ t('pages.findings') }}</a>
          <a mat-button routerLink="/sources" routerLinkActive="active" data-testid="nav-sources">{{ t('pages.sources') }}</a>
        </nav>
        @if (status(); as s) {
          <span class="status" data-testid="mode">
            {{ t('app.status', { mode: s.mode | enumLabel: 'mode', provider: s.llm.provider, naceRevision: s.naceRevision }) }}
          </span>
        }
        <a mat-stroked-button href="/api/docs" target="_blank" rel="noopener">{{ t('app.api') }}</a>
      </header>
      @if (limited()) {
        <div class="banner" role="alert" data-testid="system-warning">
          @for (w of status()?.warnings; track w) {
            <p>{{ w }}</p>
          } @empty {
            <p>{{ t('app.banner.generic') }}</p>
          }
        </div>
      }
    </ng-container>
    <main><router-outlet /></main>
  `,
})
export class App {
  /** Generated API client for system endpoints. */
  private readonly system = inject(SystemService);
  /** System status, polled every 30 s. */
  private readonly statusResource = polled(() => this.system.getSystemStatus(), 30_000);
  /** Latest system status (undefined until loaded). */
  protected readonly status = this.statusResource.value;
  /** Show the banner when the server warns, in offline mode or with an unconfigured provider (then with a generic warning). */
  protected readonly limited = computed((): boolean => {
    const s = this.status();
    return (
      !!s && (s.warnings.length > 0 || s.mode === 'offline' || !s.llm.configured || !s.embeddings.configured)
    );
  });
}
