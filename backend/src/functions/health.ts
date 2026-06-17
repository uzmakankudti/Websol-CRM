/**
 * Health-check endpoint.
 *
 * GET /api/health
 *   -> 200 "OK"            when the app is up
 *
 * It also reports database connectivity in a JSON body so you can tell whether
 * the function is alive AND whether it can reach MySQL. The plain "OK" required
 * by the task is included as the `status` field and as the response text when
 * the DB check is skipped.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { pingDatabase } from '../shared/db';

export async function health(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  context.log('Health check requested');

  // `?db=false` lets you check the function alone without touching MySQL.
  const checkDb = request.query.get('db') !== 'false';
  const dbOk = checkDb ? await pingDatabase() : true;

  const healthy = dbOk;
  return {
    status: healthy ? 200 : 503,
    jsonBody: {
      status: healthy ? 'OK' : 'DEGRADED',
      database: checkDb ? (dbOk ? 'up' : 'down') : 'skipped',
      timestamp: new Date().toISOString(),
    },
  };
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: health,
});
