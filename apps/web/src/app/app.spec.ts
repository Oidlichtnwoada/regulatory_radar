import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';
import enUS from '../i18n/en-US.json';
import { provideApi, type SystemStatus, SystemStatusModeEnum } from './api-client';
import { App } from './app';
import { DEFAULT_LANG } from './shared/i18n';

const status = (overrides: Partial<SystemStatus>): SystemStatus => ({
  mode: SystemStatusModeEnum.online,
  llm: { provider: 'mistral', configured: true },
  embeddings: { provider: 'mistral', configured: true },
  agentInternetAccess: true,
  warnings: [],
  asOf: '2026-11-16',
  naceRevision: '2.1',
  ...overrides,
});

/** Renders the shell and answers the first status poll with `body`. */
const render = async (body: SystemStatus): Promise<HTMLElement> => {
  TestBed.configureTestingModule({
    imports: [
      TranslocoTestingModule.forRoot({
        langs: { [DEFAULT_LANG]: enUS },
        translocoConfig: { availableLangs: [DEFAULT_LANG], defaultLang: DEFAULT_LANG },
        preloadLangs: true,
      }),
    ],
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideApi('/api/v1')],
  });
  const fixture = TestBed.createComponent(App);
  const http = TestBed.inject(HttpTestingController);
  // The first poll is issued asynchronously: wait for it instead of guessing a delay.
  const firstPoll = async (triesLeft: number): Promise<void> => {
    const [request] = http.match('/api/v1/system/status');
    if (request) return request.flush(body);
    if (triesLeft === 0) throw new Error('no /system/status request');
    await new Promise((resolve) => setTimeout(resolve, 5));
    return firstPoll(triesLeft - 1);
  };
  await firstPoll(200);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
};

describe('App shell warning banner', () => {
  it('shows the server warnings in offline mode', async () => {
    const el = await render(
      status({ mode: SystemStatusModeEnum.offline, warnings: ['Offline mode: no LLM calls.'] }),
    );
    expect(el.querySelector('[data-testid="system-warning"]')?.textContent).toContain(
      'Offline mode: no LLM calls.',
    );
    expect(el.querySelector('[data-testid="system-warning"]')?.textContent).not.toContain('Limited mode');
  });

  it('warns even without server warnings when no API key is configured', async () => {
    const el = await render(status({ llm: { provider: 'none', configured: false } }));
    const banner = el.querySelector('[data-testid="system-warning"]')?.textContent;
    expect(banner).toContain('Limited mode: offline or no external API key configured.');
  });

  it('shows no banner when online and fully configured', async () => {
    const el = await render(status({}));
    expect(el.querySelector('[data-testid="system-warning"]')).toBeNull();
  });
});
