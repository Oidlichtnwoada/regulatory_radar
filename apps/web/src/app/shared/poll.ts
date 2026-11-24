import type { ResourceRef } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { type Observable, switchMap, timer } from 'rxjs';

/** A resource that loads immediately and then reloads every `intervalMs` milliseconds. */
export const polled = <T>(load: () => Observable<T>, intervalMs: number): ResourceRef<T | undefined> =>
  rxResource({ stream: () => timer(0, intervalMs).pipe(switchMap(load)) });
