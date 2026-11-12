import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

const wildcardParamsSchema = z.object({ '*': z.string() });

/**
 * The tail of a `/prefix/*` route. The router has already percent-decoded
 * it; decoding again would turn a name such as `50%desconto.mp4` into
 * something else, so the value is used as delivered.
 */
export function wildcardPath(request: FastifyRequest): string {
  return wildcardParamsSchema.parse(request.params)['*'];
}
