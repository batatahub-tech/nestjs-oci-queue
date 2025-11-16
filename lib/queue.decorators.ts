import { Injectable, type OnModuleInit, SetMetadata } from '@nestjs/common';
import { QUEUE_CONSUMER_EVENT_HANDLER, QUEUE_CONSUMER_METHOD } from './queue.constants';

interface QueueServiceLike {
  registerHandlerInstances: (instances: unknown[]) => void;
}

export const QueueMessageHandler = (name: string, batch?: boolean) =>
  SetMetadata(QUEUE_CONSUMER_METHOD, { name, batch });
export const QueueConsumerEventHandler = (name: string, eventName: string) =>
  SetMetadata(QUEUE_CONSUMER_EVENT_HANDLER, { name, eventName });

export function QueueHandler() {
  // biome-ignore lint/suspicious/noExplicitAny: Mixin pattern requires any[] for constructor args
  return function <T extends new (...args: any[]) => object>(ctor: T) {
    Injectable()(ctor);

    return class extends ctor implements OnModuleInit {
      private queueService: QueueServiceLike | undefined;

      // biome-ignore lint/suspicious/noExplicitAny: Mixin constructor must use any[] per TypeScript requirements
      constructor(...args: any[]) {
        super(...args);
        this.queueService = args.find(
          (arg): arg is QueueServiceLike =>
            typeof arg === 'object' &&
            arg !== null &&
            'registerHandlerInstances' in arg &&
            typeof (arg as QueueServiceLike).registerHandlerInstances === 'function',
        );
      }

      async onModuleInit() {
        const globalQueueService = (global as { __QUEUE_SERVICE_INSTANCE__?: QueueServiceLike })
          .__QUEUE_SERVICE_INSTANCE__;
        if (globalQueueService && typeof globalQueueService.registerHandlerInstances === 'function') {
          globalQueueService.registerHandlerInstances([this]);
        }
        if (this.queueService) {
          this.queueService.registerHandlerInstances([this]);
        }
        const prototype = Object.getPrototypeOf(Object.getPrototypeOf(this));
        const originalOnModuleInit = prototype?.onModuleInit;
        if (
          originalOnModuleInit &&
          typeof originalOnModuleInit === 'function' &&
          originalOnModuleInit !== this.onModuleInit
        ) {
          await originalOnModuleInit.call(this);
        }
      }
    } as unknown as T;
  };
}
