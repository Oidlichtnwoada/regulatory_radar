import { provideHttpClient, withFetch } from '@angular/common/http';
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideApi } from './api-client';
import { routes } from './app.routes';
import { provideI18n } from './shared/i18n';

/** Root providers: zoneless (Angular default), router with input binding, fetch-based HTTP, the generated API client and i18n. */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    provideApi('/api/v1'),
    ...provideI18n(),
  ],
};
