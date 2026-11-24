import { describe, expect, it } from 'vitest';
import { agentCursorSql, agentReaderLoginSql, agentReaderPassword, agentReaderUrl } from './agent-reader.js';

describe('agent SQL reader', () => {
  const url = 'postgresql://radar:s3cret@db:5432/radar_online';

  it('logs in as its own role with a password derived from the owner password', () => {
    const reader = new URL(agentReaderUrl(url));
    expect(reader.username).toBe('radar_agent_reader');
    expect(reader.password).toBe(agentReaderPassword(url));
    expect(reader.password).toMatch(/^[0-9a-f]{64}$/);
    expect(reader.password).not.toContain('s3cret');
    expect(reader.pathname).toBe('/radar_online');
    expect(agentReaderPassword(url)).not.toBe(agentReaderPassword(url.replace('s3cret', 'other')));
    expect(agentReaderLoginSql(url)).toMatch(/NOSUPERUSER .* NOINHERIT .*PASSWORD '[0-9a-f]{64}'$/);
  });

  it('keeps the model query on its own lines, so a trailing comment cannot remove the row cap', () => {
    const sql = agentCursorSql('SELECT id FROM finding) AS x --;');
    expect(sql).toContain('FROM (\nSELECT id FROM finding) AS x --\n) AS agent_query');
    expect(sql.startsWith('DECLARE agent_cursor NO SCROLL CURSOR FOR')).toBe(true);
  });
});
