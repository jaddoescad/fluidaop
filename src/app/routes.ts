export const APP_ROUTES = [
  { id: 'Board', icon: '📡', path: '/', aliases: [] },
  { id: 'Agents', icon: '🤖', path: '/agents', aliases: [] },
  { id: 'Skills', icon: '🧩', path: '/skills', aliases: [] },
  { id: 'Actions', icon: '✓', path: '/actions', aliases: [] },
  { id: 'Activity', icon: '⚡', path: '/activity', aliases: ['/activities'] },
  { id: 'Labels', icon: '🏷️', path: '/labels', aliases: [] },
  { id: 'Schedules', icon: '◷', path: '/schedules', aliases: ['/automations'] },
  { id: 'Connections', icon: '🔌', path: '/connections', aliases: [] },
  { id: 'Contacts', icon: '👥', path: '/contacts', aliases: ['/people'] },
  { id: 'Employees', icon: '🧑‍🔧', path: '/employees', aliases: [] },
] as const;

export type AppPage = typeof APP_ROUTES[number]['id'];

export function pageFromPath(pathname: string): AppPage {
  const route = APP_ROUTES.find((item) => pathname === item.path
    || item.aliases.some((alias) => pathname === alias)
    || (item.id === 'Agents' && pathname.startsWith('/agents/')));
  return route?.id ?? 'Board';
}

export function pathForPage(page: AppPage): string {
  return APP_ROUTES.find((item) => item.id === page)?.path ?? '/';
}

export function isAppPage(value: string): value is AppPage {
  return APP_ROUTES.some((item) => item.id === value);
}
