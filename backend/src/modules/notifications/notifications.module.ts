import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { PrismaService } from '../../prisma/prisma.service';
import { TaskDispatchService } from '../assignments/dispatch.service';
import { LoggingPushTransport, PushService, PushTransport } from './push.service';
import { PushController } from './push.controller';

/**
 * Worker push notifications.
 *
 * ONE notification event path: domain code calls PushService, PushService
 * resolves the audience by PERMISSION and hands the message to the
 * transport. Swapping in real FCM is a transport change only.
 */
@Module({
  imports: [PrismaModule, AssignmentsModule],
  controllers: [PushController],
  providers: [
    {
      provide: PushService,
      useFactory: (prisma: PrismaService, dispatch: TaskDispatchService) => {
        const transport: PushTransport = new LoggingPushTransport();
        return new PushService(prisma, dispatch, transport);
      },
      inject: [PrismaService, TaskDispatchService],
    },
  ],
  exports: [PushService],
})
export class NotificationsModule {}
