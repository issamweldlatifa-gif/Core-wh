import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/**
 * Uniform API error envelope, applied globally so every error (validation,
 * unauthorized, forbidden, not found, internal) is returned in one shape:
 *
 *   {
 *     statusCode: 400,
 *     message: "..." | ["...", "..."],
 *     error: "Bad Request",
 *     path: "/api/v1/auth/login",
 *     timestamp: "..."
 *   }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error.';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const r = res as any;
        message = r.message ?? exception.message;
        error = r.error ?? exception.message;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Surface schema-drift clearly instead of a blind 500. P2021 = missing
      // table, P2022 = missing column: the deployed code is newer than the
      // database schema (migrations not applied / half-applied).
      if (exception.code === 'P2021' || exception.code === 'P2022') {
        message =
          'Database schema is out of date (missing table/column). ' +
          'Run migrations / redeploy.';
        error = 'Schema Drift';
      }
      this.logger.error(
        `Prisma ${exception.code} on ${request.method} ${request.url}: ${exception.message}`,
      );
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}: ${exception.message}`,
        exception.stack,
      );
    } else {
      this.logger.error(
        `Unhandled non-Error exception on ${request.method} ${request.url}: ${String(exception)}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      error,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
