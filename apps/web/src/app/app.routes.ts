import type { Routes } from '@angular/router';

/** Lazy-loaded pages of the radar; titles are translation keys. */
export const routes: Routes = [
  {
    path: '',
    title: 'pages.radar',
    loadComponent: () => import('./features/radar/radar.page').then((m) => m.RadarPage),
  },
  {
    path: 'groups/:groupKey',
    title: 'pages.group',
    loadComponent: () => import('./features/group/group.page').then((m) => m.GroupPage),
  },
  {
    path: 'findings',
    title: 'pages.findings',
    loadComponent: () => import('./features/findings/findings.page').then((m) => m.FindingsPage),
  },
  {
    path: 'findings/:id',
    title: 'pages.finding',
    loadComponent: () => import('./features/findings/finding.page').then((m) => m.FindingPage),
  },
  {
    path: 'sources',
    title: 'pages.sources',
    loadComponent: () => import('./features/sources/sources.page').then((m) => m.SourcesPage),
  },
  { path: '**', redirectTo: '' },
];
