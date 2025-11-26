import { SetMetadata } from '@nestjs/common';
import { QUEUE_CONSUMER_EVENT_HANDLER, QUEUE_CONSUMER_METHOD } from './queue.constants';

export const QueueConsumer = (queueName: string, options?: { batch?: boolean }) =>
  SetMetadata(QUEUE_CONSUMER_METHOD, { name: queueName, batch: options?.batch ?? false });

export const QueueConsumerEventHandler = (queueName: string, eventName: 'error' | 'processing_error') =>
  SetMetadata(QUEUE_CONSUMER_EVENT_HANDLER, { name: queueName, eventName });

export const QueueMessageHandler = QueueConsumer;
