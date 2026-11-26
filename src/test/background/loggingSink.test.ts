import {
  createLoggingSink,
  describeSinkError,
} from '@/background/events/loggingSink';

describe('logging sink', () => {
  it('writes one line per snapshot without the file text', () => {
    const lines: string[] = [];
    const sink = createLoggingSink((line) => lines.push(line));

    sink.submit({
      workspaceId: 'file:///w',
      fileUri: 'file:///w/A.java',
      languageId: 'java',
      version: 7,
      content: 'SECRET_BODY',
      trigger: 'edit',
      observedAt: 0,
    });

    expect(lines).toEqual([
      '1970-01-01T00:00:00.000Z edit v7 11 chars file:///w/A.java [file:///w]',
    ]);
    expect(lines[0]).not.toContain('SECRET_BODY');
  });

  it('writes one line per closed notice', () => {
    const lines: string[] = [];
    const sink = createLoggingSink((line) => lines.push(line));

    sink.closed({
      workspaceId: 'no-workspace',
      fileUri: 'file:///x/B.java',
      observedAt: 0,
    });

    expect(lines).toEqual([
      '1970-01-01T00:00:00.000Z closed file:///x/B.java [no-workspace]',
    ]);
  });

  it('describes sink errors of any type', () => {
    expect(describeSinkError(new Error('x'))).toBe('sink error: x');
    expect(describeSinkError('y')).toBe('sink error: y');
  });
});

describe('logging sink: version rescans (card 11)', () => {
  it('names the version trigger as given, without the file text', () => {
    const lines: string[] = [];
    const sink = createLoggingSink((line) => lines.push(line));

    sink.submit({
      workspaceId: 'file:///w',
      fileUri: 'file:///w/A.java',
      languageId: 'java',
      version: 3,
      content: 'SECRET_BODY',
      trigger: 'version',
      observedAt: 0,
    });

    expect(lines).toEqual([
      '1970-01-01T00:00:00.000Z version v3 11 chars file:///w/A.java [file:///w]',
    ]);
    expect(lines[0]).not.toContain('SECRET_BODY');
  });
});
