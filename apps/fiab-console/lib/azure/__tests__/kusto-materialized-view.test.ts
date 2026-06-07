import { describe, it, expect } from 'vitest';
import { buildCreateMaterializedViewCommand } from '../kusto-mv-command';

describe('buildCreateMaterializedViewCommand', () => {
  const Q = 'Events | summarize cnt = count() by bin(ts, 1d)';

  it('builds a plain (non-backfill) create command', () => {
    const cmd = buildCreateMaterializedViewCommand('EventsDaily', 'Events', Q);
    expect(cmd).toBe(
      `.create materialized-view EventsDaily on table ["Events"] { ${Q} }`,
    );
    // No async / backfill on the default path.
    expect(cmd).not.toContain('async');
    expect(cmd).not.toContain('backfill');
  });

  it('emits async + with (backfill=true) when backfill is requested', () => {
    const cmd = buildCreateMaterializedViewCommand('EventsDaily', 'Events', Q, { backfill: true });
    expect(cmd).toBe(
      `.create async materialized-view with (backfill=true) EventsDaily on table ["Events"] { ${Q} }`,
    );
    // async MUST precede the materialized-view keyword for a backfilling create.
    expect(cmd.indexOf('async')).toBeLessThan(cmd.indexOf('materialized-view'));
  });

  it('backfill:false behaves like the default path', () => {
    const cmd = buildCreateMaterializedViewCommand('M', 'Src', Q, { backfill: false });
    expect(cmd).not.toContain('async');
    expect(cmd).not.toContain('backfill');
  });

  it('bracket-quotes the source table and trims query whitespace', () => {
    const cmd = buildCreateMaterializedViewCommand('M', '  Raw Events  ', `  ${Q}  `);
    expect(cmd).toContain('on table ["Raw Events"]');
    expect(cmd).toContain(`{ ${Q} }`);
  });
});
