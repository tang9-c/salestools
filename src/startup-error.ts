export function formatStartupFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'Application startup failed: Unknown error\n';

  const detail = `${error.name}: ${error.message}`.replace(/[\r\n]+/g, ' ');
  return `Application startup failed: ${detail}\n`;
}
