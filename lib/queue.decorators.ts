import { Injectable, OnModuleInit, SetMetadata } from '@nestjs/common';
import { QUEUE_CONSUMER_EVENT_HANDLER, QUEUE_CONSUMER_METHOD } from './queue.constants';

export const QueueMessageHandler = (name: string, batch?: boolean) =>
  SetMetadata(QUEUE_CONSUMER_METHOD, { name, batch });
export const QueueConsumerEventHandler = (name: string, eventName: string) =>
  SetMetadata(QUEUE_CONSUMER_EVENT_HANDLER, { name, eventName });

export function QueueHandler() {
  return function <T extends { new (...args: any[]): Record<string, any> }>(constructor: T) {
    Injectable()(constructor);

    return class extends constructor implements OnModuleInit {
      private queueService: any;

      constructor(...args: any[]) {
        super(...args);
        this.queueService = args.find((arg) => arg && typeof arg.registerHandlerInstances === 'function');
      }

      async onModuleInit() {
        const queueService = (global as any).__QUEUE_SERVICE_INSTANCE__;
        if (queueService && typeof queueService.registerHandlerInstances === 'function') {
          queueService.registerHandlerInstances([this]);
        }
        if (this.queueService) {
          this.queueService.registerHandlerInstances([this]);
        }
        const originalOnModuleInit = (this as any).__proto__.__proto__.onModuleInit;
        if (
          originalOnModuleInit &&
          typeof originalOnModuleInit === 'function' &&
          originalOnModuleInit !== this.onModuleInit
        ) {
          await originalOnModuleInit.call(this);
        }
      }
    } as any;
  };
}
