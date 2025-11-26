import type { InjectionToken, LoggerService, ModuleMetadata, Type } from '@nestjs/common';
import type { QueueClient } from 'oci-queue';

export type QueueName = string;

export interface OciQueueConsumerOptions {
  name: QueueName;
  queueId: string;
  region?: string;
  profile?: string;
  endpoint?: string;
  visibilityTimeoutInSeconds?: number;
  timeoutInSeconds?: number;
  maxMessages?: number;
  pollingInterval?: number;
  stopOnError?: boolean;
}

export interface OciQueueConsumerMapValues {
  queueId: string;
  queueClient: QueueClient;
  pollingInterval: number;
  isRunning: boolean;
  stopOnError: boolean;
  timeoutId?: NodeJS.Timeout;
  consecutiveAuthErrors?: number;
}

export interface OciQueueProducerOptions {
  name: QueueName;
  queueId: string;
  region?: string;
  profile?: string;
  endpoint?: string;
}

export interface OciQueueProducerOptionsInternal extends OciQueueProducerOptions {
  queueClient: QueueClient;
}

export interface QueueOptions {
  consumers?: OciQueueConsumerOptions[];
  producers?: OciQueueProducerOptions[];
  profile?: string;
  region?: string;
  endpoint?: string;
  logger?: LoggerService;

  localMode?: boolean;
}

export interface QueueModuleOptionsFactory {
  createOptions(): Promise<QueueOptions> | QueueOptions;
}

export interface QueueModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useExisting?: Type<QueueModuleOptionsFactory>;
  useClass?: Type<QueueModuleOptionsFactory>;
  useFactory?: (...args: unknown[]) => Promise<QueueOptions> | QueueOptions;
  inject?: InjectionToken[];
}

export interface Message<T = unknown> {
  id?: string;
  body: T;
  delaySeconds?: number;
  metadata?: {
    channelId?: string;
    customProperties?: Record<string, string>;
  };
}

export interface QueueMessageHandlerMeta {
  name: string;
  batch?: boolean;
}

export interface QueueConsumerEventHandlerMeta {
  name: string;
  eventName: string;
}

export interface OciQueueReceivedMessage {
  id: string;
  receiptHandle: string;
  content: string;
  metadata?: Record<string, string>;
  Body?: string;
  MessageId?: string;
}

export type OciQueueConsumerEventHandlerMeta = QueueConsumerEventHandlerMeta;
export type OciQueueMessageHandlerMeta = QueueMessageHandlerMeta;
