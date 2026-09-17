/**
 * Entrypoint: `tool-dictionary [config.json]`.
 *
 * Every configured dictionary is loaded before the port opens, so a failing
 * dictionary is a failing start rather than a 503 discovered by an agent.
 */
import { ConfigError, loadConfig } from './config';
import { buildServer } from './http/server';
import { DictionaryService, ServiceError } from './service';

export { generateFromOpenApi, GenerateError, type GenerateOptions, type GenerateResult } from './generate/openapi';
export { applyOverlay, OverlayError, type Overlay, type OverlayResult } from './generate/overlay';
export { buildServer, type ServerOptions } from './http/server';
export { agentBundle, agentTools, systemPrompt, usagePrompt, type AgentOptions, type DictionaryDescription } from './agent';
export { DictionaryService, ServiceError, type RawExecuteRequest } from './service';
export { Executor, DEFAULT_EXECUTION, declaredOrigins, renderExecuteText, type ExecutionConfig, type ExecuteRequest, type ExecuteResponse, type IncomingHeaders } from './execute';
export type { ErrorCode } from './errors';
export { loadDictionary, LoadError, effectiveCall } from './load';
export { resolveCall, ResolveError, type ResolveOptions, type ResolvedRequest } from './resolve';
export { validateDictionary } from './validate';
export { renderResultsText, renderIndexText, renderEntriesText } from './render/text';
export type * from './types';

async function main(): Promise<void> {
  const file = process.argv[2] ?? process.env.TD_CONFIG;
  const config = await loadConfig(file);
  const service = new DictionaryService({
    limits: config.limits ?? {},
    threshold: config.threshold ?? {},
    globalAdminTokens: config.adminTokens,
    ...(config.execution !== undefined ? { execution: config.execution } : {}),
  });
  for (const d of config.dictionaries) {
    const status = await service.install(d);
    const warn = status.warnings ? ` (${status.warnings} warning${status.warnings === 1 ? '' : 's'})` : '';
    const exec = service.executable(status.id) ? ', executes' : '';
    process.stdout.write(`loaded ${status.id} v${status.version} — ${status.entryCount} entries${warn}${exec}\n`);
    for (const b of status.branches) {
      process.stdout.write(`  branch ${b.path} -> ${b.dictionaryId}: ${b.ok ? `ok, ${b.entryCount} entries` : `DEGRADED: ${b.error}`}\n`);
    }
  }
  if (config.dictionaries.length === 0 && config.adminTokens.length === 0) {
    throw new ConfigError('no dictionaries configured and no admin tokens: nothing could ever be served. Add a dictionary or TD_ADMIN_TOKENS.');
  }

  const app = buildServer({
    service,
    logger: config.logger ?? true,
    ...(config.bodyLimitBytes !== undefined ? { bodyLimitBytes: config.bodyLimitBytes } : {}),
    ...(config.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: config.rateLimitPerMinute } : {}),
    ...(config.publicBaseUrl !== undefined ? { publicBaseUrl: config.publicBaseUrl } : {}),
    ...(config.trustProxy !== undefined ? { trustProxy: config.trustProxy } : {}),
  });
  const shutdown = async () => {
    await app.close();
    await service.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await app.listen({ host: config.host, port: config.port });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) process.stderr.write(`config: ${error.message}\n`);
    else if (error instanceof ServiceError) process.stderr.write(`${error.code}: ${error.message}\n${error.details.map((d) => `  ${JSON.stringify(d)}`).join('\n')}\n`);
    else process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
