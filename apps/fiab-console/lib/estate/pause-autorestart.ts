/**
 * ESTATE PAUSE - the flexible-server auto-restart facts (#5099 phase B). Pure and
 * dependency-free so the panel (a client bundle) and the re-stop logic share ONE
 * source for the numbers.
 *
 * Microsoft Learn, verified 2026-10-23:
 *   - PostgreSQL flexible server: "Server will be automatically started after 7
 *     days if you do not perform a manual start operation" (how-to-stop-server).
 *   - MySQL flexible server: a server stopped for 30 days is automatically started
 *     (how-to-stop-start-server-portal). The two engines differ.
 */

/** Days after which Azure restarts a stopped flexible server on its own, per engine. */
export const AUTO_RESTART_DAYS: Readonly<Record<string, number>> = {
  'microsoft.dbforpostgresql/flexibleservers': 7,
  'microsoft.dbformysql/flexibleservers': 30,
};

/** True for a type whose restart under a PAUSED estate is Azure's own scheduled behaviour. */
export function isAutoRestartType(resourceType: string): boolean {
  return String(resourceType ?? '').toLowerCase() in AUTO_RESTART_DAYS;
}

/** The caption the panel shows on a flexible-server row, or null for any other type. */
export function autoRestartCaption(resourceType: string): string | null {
  const days = AUTO_RESTART_DAYS[String(resourceType ?? '').toLowerCase()];
  if (!days) return null;
  return (
    `Azure restarts a stopped server of this type on its own after ${days} days. While the estate stays paused, `
    + 'the idle auto-pause lane re-stops it on its next 30-minute read, unless an app that uses it is running again.'
  );
}
