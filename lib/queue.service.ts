import {
  Inject,
  Injectable,
  Logger,
  type LoggerService,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
  type Type,
} from '@nestjs/common';
import { type MetadataScanner, type ModuleRef, ModulesContainer, type Reflector } from '@nestjs/core';
import * as common from 'oci-common';
import { type models, QueueClient, type requests } from 'oci-queue';
import { QUEUE_CONSUMER_EVENT_HANDLER, QUEUE_CONSUMER_METHOD, QUEUE_OPTIONS } from './queue.constants';
import { MockQueueClient } from './queue.mock';
import type {
  Message,
  OciQueueConsumerMapValues,
  OciQueueConsumerOptions,
  OciQueueProducerOptionsInternal,
  OciQueueReceivedMessage,
  QueueConsumerEventHandlerMeta,
  QueueMessageHandlerMeta,
  QueueName,
  QueueOptions,
} from './queue.types';

@Injectable()
export class QueueService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  public readonly consumers = new Map<QueueName, OciQueueConsumerMapValues>();
  public readonly producers = new Map<QueueName, OciQueueProducerOptionsInternal>();

  private logger: LoggerService;
  private queueClients = new Map<string, QueueClient | MockQueueClient>();
  private manualHandlerInstances: Set<unknown> = new Set();
  private handlerDiscoveryCache = new Map<
    string | symbol,
    Array<{ meta: unknown; handler: (...args: unknown[]) => unknown; instance: unknown }>
  >();
  private eventHandlersCache = new Map<
    QueueName,
    Array<{ meta: QueueConsumerEventHandlerMeta; handler: (...args: unknown[]) => unknown; instance: unknown }>
  >();
  private readonly skippedTokens = new Set([
    'ModuleRef',
    'Reflector',
    'ModulesContainer',
    'MetadataScanner',
    'QueueService',
    'QUEUE_OPTIONS',
  ]);

  public constructor(
    @Inject(QUEUE_OPTIONS) public readonly options: QueueOptions,
    private readonly reflector: Reflector,
    private readonly modulesContainer: ModulesContainer,
    private readonly metadataScanner: MetadataScanner,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private createQueueClient(profile?: string, region?: string, endpoint?: string): QueueClient {
    const key = `${profile || 'default'}-${region || 'default'}-${endpoint || 'default'}`;

    const cached = this.queueClients.get(key);
    if (cached) {
      return cached as QueueClient;
    }

    const localMode = this.options.localMode ?? process.env.OCI_QUEUE_LOCAL_MODE === 'true';

    if (localMode) {
      const client = new MockQueueClient();
      this.queueClients.set(key, client);

      return client as unknown as QueueClient;
    }

    try {
      const configFile = process.env.OCI_CONFIG_FILE || undefined;
      const profileName = profile || this.options.profile || 'DEFAULT';

      const authenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(configFile, profileName);

      const clientConfig: { authenticationDetailsProvider: common.AuthenticationDetailsProvider } = {
        authenticationDetailsProvider,
      };

      const client = new QueueClient(clientConfig);

      if (endpoint) {
        client.endpoint = endpoint;
      }

      this.queueClients.set(key, client);
      return client;
    } catch (error) {
      this.logger.error(
        `Failed to create OCI QueueClient. Error: ${error instanceof Error ? error.message : String(error)}. ` +
          `Please ensure: 1) OCI config file exists at ~/.oci/config (or set OCI_CONFIG_FILE), ` +
          `2) Profile '${profile || this.options.profile || 'DEFAULT'}' exists in config, ` +
          `3) Credentials are valid. ` +
          `Alternatively, enable local mode by setting OCI_QUEUE_LOCAL_MODE=true in .env file.`,
      );
      throw error;
    }
  }

  public async onModuleInit(): Promise<void> {
    this.logger = this.options.logger ?? new Logger('OciQueueService', { timestamp: false });

    (global as { __QUEUE_SERVICE_INSTANCE__?: QueueService }).__QUEUE_SERVICE_INSTANCE__ = this;

    this.options.producers?.forEach((options) => {
      const { name, queueId, profile, region } = options;
      if (this.producers.has(name)) {
        throw new Error(`Producer already exists: ${name}`);
      }

      const endpoint = options.endpoint || this.options.endpoint;
      const queueClient = this.createQueueClient(
        profile || this.options.profile,
        region || this.options.region,
        endpoint,
      );

      const producer: OciQueueProducerOptionsInternal = {
        name,
        queueId,
        queueClient,
        region,
        profile,
        endpoint,
      };

      this.producers.set(name, producer);
    });
  }

  public async onApplicationBootstrap(): Promise<void> {
    let messageHandlers = this.providerMethodsWithMetaAtKey<QueueMessageHandlerMeta>(QUEUE_CONSUMER_METHOD);
    let eventHandlers = this.providerMethodsWithMetaAtKey<QueueConsumerEventHandlerMeta>(QUEUE_CONSUMER_EVENT_HANDLER);

    if (messageHandlers.length === 0 && this.options.consumers && this.options.consumers.length > 0) {
      const delays = [50, 100, 200, 500, 1000];
      for (const delay of delays) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        messageHandlers = this.providerMethodsWithMetaAtKey<QueueMessageHandlerMeta>(QUEUE_CONSUMER_METHOD);
        eventHandlers = this.providerMethodsWithMetaAtKey<QueueConsumerEventHandlerMeta>(QUEUE_CONSUMER_EVENT_HANDLER);
        if (messageHandlers.length > 0) {
          break;
        }
      }

      if (messageHandlers.length === 0 && !this.moduleRef) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        messageHandlers = this.providerMethodsWithMetaAtKey<QueueMessageHandlerMeta>(QUEUE_CONSUMER_METHOD);
        eventHandlers = this.providerMethodsWithMetaAtKey<QueueConsumerEventHandlerMeta>(QUEUE_CONSUMER_EVENT_HANDLER);
      }
    }

    this.options.consumers?.forEach((options) => {
      const { name, queueId, profile, region, pollingInterval = 1000, stopOnError = false } = options;
      if (this.consumers.has(name)) {
        throw new Error(`Consumer already exists: ${name}`);
      }

      const localMode = this.options.localMode ?? process.env.OCI_QUEUE_LOCAL_MODE === 'true';
      if (!localMode && !queueId.startsWith('ocid1.')) {
        this.logger.warn(
          `Queue ID '${queueId}' does not appear to be a valid OCID (should start with 'ocid1.'). ` +
            `If you're using a URL, please use the OCID instead. ` +
            `To use local mode, set OCI_QUEUE_LOCAL_MODE=true in .env`,
        );
      }

      const metadata = messageHandlers.find(({ meta }) => meta.name === name);
      if (!metadata) {
        const availableHandlers = messageHandlers.map((h) => h.meta.name);
        const moduleCount = this.modulesContainer
          ? this.modulesContainer.size || Array.from(this.modulesContainer.entries()).length
          : 0;
        this.logger.warn(
          `No metadata found for: ${name}. ` +
            `Available handlers: [${availableHandlers.join(', ') || 'none'}]. ` +
            `ModuleRef available: ${this.moduleRef ? 'yes' : 'no'}. ` +
            `ModulesContainer entries: ${moduleCount}`,
        );
        return;
      }

      const isBatchHandler = metadata.meta.batch === true;
      const handler = metadata.handler.bind(metadata.instance);

      const eventsMetadata = eventHandlers.filter(({ meta }) => meta.name === name);

      const endpoint = options.endpoint || this.options.endpoint;
      const queueClient = this.createQueueClient(
        profile || this.options.profile,
        region || this.options.region,
        endpoint,
      );

      const consumer: OciQueueConsumerMapValues = {
        queueId,
        queueClient,
        pollingInterval,
        isRunning: true,
        stopOnError,
      };

      this.startPolling(name, consumer, handler, isBatchHandler, eventsMetadata, options);

      this.consumers.set(name, consumer);
    });
  }

  private async startPolling(
    name: QueueName,
    consumer: OciQueueConsumerMapValues,
    handler: (message: OciQueueReceivedMessage | OciQueueReceivedMessage[]) => Promise<void>,
    isBatchHandler: boolean,
    eventsMetadata: Array<{
      meta: QueueConsumerEventHandlerMeta;
      handler: (...args: unknown[]) => unknown;
      instance: unknown;
    }>,
    options: OciQueueConsumerOptions,
  ) {
    let consecutiveErrors = 0;
    const maxBackoffDelay = Math.min(consumer.pollingInterval * 32, 30000);
    const baseBackoffDelay = Math.min(consumer.pollingInterval, 1000);

    const poll = async () => {
      if (!consumer.isRunning) {
        return;
      }

      const startTime = Date.now();
      let shouldContinue = true;

      try {
        const getMessagesRequest: requests.GetMessagesRequest = {
          queueId: consumer.queueId,
          visibilityInSeconds: options.visibilityTimeoutInSeconds ?? 30,
          timeoutInSeconds: options.timeoutInSeconds ?? 30,
          limit: options.maxMessages ?? 10,
        };

        const response = await consumer.queueClient.getMessages(getMessagesRequest);
        const messages = response.getMessages?.messages || [];

        consecutiveErrors = 0;
        if (consumer.consecutiveAuthErrors) {
          consumer.consecutiveAuthErrors = 0;
        }

        if (messages.length > 0) {
          const receivedMessages: OciQueueReceivedMessage[] = new Array(messages.length);
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            receivedMessages[i] = {
              id: String(msg.id || ''),
              receiptHandle: msg.receipt || '',
              content: msg.content || '',
              metadata: msg.metadata?.customProperties,
            };
          }

          try {
            if (isBatchHandler) {
              await handler(receivedMessages);
            } else {
              for (let i = 0; i < receivedMessages.length; i++) {
                await handler(receivedMessages[i]);
              }
            }

            const deletePromises: Promise<unknown>[] = [];
            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i];
              if (msg.receipt) {
                deletePromises.push(
                  consumer.queueClient
                    .deleteMessage({
                      queueId: consumer.queueId,
                      messageReceipt: msg.receipt,
                    })
                    .catch((err) => {
                      this.logger.warn(`Failed to delete message ${msg.id}: ${err}`);
                    }),
                );
              }
            }
            await Promise.allSettled(deletePromises);
          } catch (error) {
            this.logger.warn(`Error processing messages for queue ${name}: ${error}`);
            this.emitEvent(eventsMetadata, 'processing_error', error, receivedMessages);

            if (consumer.stopOnError) {
              consumer.isRunning = false;
              shouldContinue = false;
            }
          }
        }
      } catch (error) {
        consecutiveErrors++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isAuthError =
          errorMessage.includes('Authorization failed') ||
          errorMessage.includes('NotAuthenticated') ||
          errorMessage.includes('401') ||
          errorMessage.includes('403');

        if (isAuthError) {
          consumer.consecutiveAuthErrors = (consumer.consecutiveAuthErrors || 0) + 1;

          if (consumer.consecutiveAuthErrors === 1 || consumer.consecutiveAuthErrors % 10 === 0) {
            this.logger.error(
              `Authentication/Authorization error polling queue ${name} (${consumer.consecutiveAuthErrors} consecutive errors): ${errorMessage}. ` +
                `Please check: 1) OCI credentials in ~/.oci/config, ` +
                `2) Profile '${this.options.profile || 'DEFAULT'}' is correct, ` +
                `3) Queue ID '${consumer.queueId}' is a valid OCID (not a URL), ` +
                `4) Your OCI user has permissions to access the queue. ` +
                `To use local mode instead, set OCI_QUEUE_LOCAL_MODE=true in .env`,
            );

            if (consumer.consecutiveAuthErrors >= 10) {
              this.logger.error(
                `Stopping consumer '${name}' after 10 consecutive authentication errors. ` +
                  `Please fix the configuration and restart the application.`,
              );
              consumer.isRunning = false;
              shouldContinue = false;
            }
          }
        } else {
          consumer.consecutiveAuthErrors = 0;
          this.logger.warn(`Error polling queue ${name}: ${errorMessage}`);
        }
        this.emitEvent(eventsMetadata, 'error', error, []);
      }

      if (consumer.isRunning && shouldContinue) {
        const elapsed = Date.now() - startTime;
        let delay = consumer.pollingInterval;

        if (consecutiveErrors > 0) {
          delay = Math.min(baseBackoffDelay * 2 ** Math.min(consecutiveErrors - 1, 5), maxBackoffDelay);
        } else if (elapsed < consumer.pollingInterval) {
          delay = consumer.pollingInterval - elapsed;
        }

        consumer.timeoutId = setTimeout(poll, Math.max(delay, 0));
      }
    };

    poll();
  }

  private emitEvent(
    eventsMetadata: Array<{
      meta: QueueConsumerEventHandlerMeta;
      handler: (...args: unknown[]) => unknown;
      instance: unknown;
    }>,
    eventName: string,
    error: unknown,
    messages: OciQueueReceivedMessage[],
  ) {
    const eventMetadata = eventsMetadata.find(({ meta }) => meta.eventName === eventName);
    if (eventMetadata) {
      try {
        const handler = eventMetadata.handler.bind(eventMetadata.instance);
        if (eventName === 'processing_error' && messages.length > 0) {
          handler(error, messages[0]);
        } else {
          handler(error);
        }
      } catch (err) {
        this.logger.error(`Error in event handler: ${err}`);
      }
    }
  }

  public registerHandlerInstances(instances: unknown[]): void {
    for (const instance of instances) {
      if (instance && typeof instance === 'object') {
        this.manualHandlerInstances.add(instance);
      }
    }
    this.handlerDiscoveryCache.clear();
  }

  private providerMethodsWithMetaAtKey<T>(
    metadataKey: symbol | string,
  ): Array<{ meta: T; handler: (...args: unknown[]) => unknown; instance: unknown }> {
    const cacheKey = String(metadataKey);
    const cached = this.handlerDiscoveryCache.get(cacheKey);
    if (cached) {
      return cached as Array<{ meta: T; handler: (...args: unknown[]) => unknown; instance: unknown }>;
    }

    const results: Array<{ meta: T; handler: (...args: unknown[]) => unknown; instance: unknown }> = [];

    for (const instance of this.manualHandlerInstances) {
      if (!instance || typeof instance !== 'object') {
        continue;
      }

      const prototype = Object.getPrototypeOf(instance);
      if (!prototype) {
        continue;
      }

      const methodNames = this.metadataScanner.getAllMethodNames(prototype);

      for (const methodName of methodNames) {
        try {
          const method = prototype[methodName];
          if (typeof method !== 'function') {
            continue;
          }

          const metadata = this.reflector.get<T>(metadataKey, method);

          if (metadata) {
            results.push({
              meta: metadata,
              handler: method,
              instance,
            });
          }
        } catch {}
      }
    }

    let containerToUse: ModulesContainer | undefined = this.modulesContainer;

    if (this.moduleRef) {
      try {
        const appModulesContainer = this.moduleRef.get(ModulesContainer, { strict: false });
        if (appModulesContainer && typeof appModulesContainer.entries === 'function') {
          const moduleCount = appModulesContainer.size || Array.from(appModulesContainer.entries()).length;
          if (moduleCount > 0) {
            containerToUse = appModulesContainer;
          }
        }
      } catch {
        containerToUse = this.modulesContainer;
      }
    }

    const isEmpty = !containerToUse || (containerToUse.size !== undefined && containerToUse.size === 0);

    if (isEmpty && this.moduleRef) {
      const commonHandlerNames = ['MessageHandler'];
      for (const handlerName of commonHandlerNames) {
        try {
          const handlerInstance = this.moduleRef.get(handlerName as string, { strict: false });
          if (handlerInstance && typeof handlerInstance === 'object') {
            const prototype = Object.getPrototypeOf(handlerInstance);
            if (prototype) {
              const methodNames = this.metadataScanner.getAllMethodNames(prototype);
              for (const methodName of methodNames) {
                try {
                  const method = prototype[methodName];
                  if (typeof method !== 'function') {
                    continue;
                  }
                  const metadata = this.reflector.get<T>(metadataKey, method);
                  if (metadata) {
                    results.push({
                      meta: metadata,
                      handler: method,
                      instance: handlerInstance,
                    });
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }
    }

    if (containerToUse && typeof containerToUse.entries === 'function') {
      const processedTokens = new Set<string | symbol | Type<unknown>>();

      for (const [, module] of containerToUse.entries()) {
        const providers = module.providers;

        if (!providers) {
          continue;
        }

        for (const [providerToken, provider] of providers.entries()) {
          const tokenStr = String(providerToken);
          let shouldSkip = false;
          for (const skipped of this.skippedTokens) {
            if (tokenStr.includes(skipped)) {
              shouldSkip = true;
              break;
            }
          }
          if (shouldSkip) {
            continue;
          }

          if (processedTokens.has(providerToken)) {
            continue;
          }
          processedTokens.add(providerToken);

          let instance: unknown;

          try {
            if (this.moduleRef) {
              try {
                instance = this.moduleRef.get(providerToken as Type<unknown>, { strict: false });
                if (!instance) {
                  const providerInternal = provider as { metatype?: Type<unknown> };
                  if (providerInternal.metatype && typeof providerInternal.metatype === 'function') {
                    instance = this.moduleRef.get(providerInternal.metatype, { strict: false });
                  }
                }
              } catch {
                if (provider.instance) {
                  instance = provider.instance;
                } else {
                  const providerInternal = provider as { instance?: unknown };
                  if (providerInternal.instance !== undefined && providerInternal.instance !== null) {
                    instance = providerInternal.instance;
                  }
                }
              }
            } else {
              if (provider.instance) {
                instance = provider.instance;
              } else {
                const providerInternal = provider as { instance?: unknown };
                if (providerInternal.instance !== undefined && providerInternal.instance !== null) {
                  instance = providerInternal.instance;
                }
              }
            }
          } catch {
            continue;
          }

          if (!instance || typeof instance !== 'object') {
            continue;
          }

          const prototype = Object.getPrototypeOf(instance);
          if (!prototype) {
            continue;
          }

          const methodNames = this.metadataScanner.getAllMethodNames(prototype);

          for (const methodName of methodNames) {
            try {
              const method = prototype[methodName];
              if (typeof method !== 'function') {
                continue;
              }

              const metadata = this.reflector.get<T>(metadataKey, method);

              if (metadata) {
                results.push({
                  meta: metadata,
                  handler: method,
                  instance,
                });
              }
            } catch {}
          }
        }
      }
    }

    this.handlerDiscoveryCache.set(cacheKey, results);
    return results;
  }

  public async rediscoverHandlers(): Promise<void> {
    if (!this.modulesContainer || typeof this.modulesContainer.entries !== 'function') {
      this.logger.warn('ModulesContainer not available for handler discovery');
      return;
    }

    const messageHandlers = this.providerMethodsWithMetaAtKey<QueueMessageHandlerMeta>(QUEUE_CONSUMER_METHOD);
    const eventHandlers =
      this.providerMethodsWithMetaAtKey<QueueConsumerEventHandlerMeta>(QUEUE_CONSUMER_EVENT_HANDLER);

    this.options.consumers?.forEach((options) => {
      const { name, queueId, profile, region, pollingInterval = 1000, stopOnError = false } = options;

      if (this.consumers.has(name) && this.consumers.get(name)?.isRunning) {
        return;
      }

      const metadata = messageHandlers.find(({ meta }) => meta.name === name);
      if (!metadata) {
        this.logger.warn(`No metadata found for: ${name}`);
        return;
      }

      const isBatchHandler = metadata.meta.batch === true;
      const handler = metadata.handler.bind(metadata.instance);

      let eventsMetadata = this.eventHandlersCache.get(name);
      if (!eventsMetadata) {
        eventsMetadata = eventHandlers.filter(({ meta }) => meta.name === name);
        if (eventsMetadata.length > 0) {
          this.eventHandlersCache.set(name, eventsMetadata);
        }
      }

      const endpoint = options.endpoint || this.options.endpoint;
      const queueClient = this.createQueueClient(
        profile || this.options.profile,
        region || this.options.region,
        endpoint,
      );

      const consumer: OciQueueConsumerMapValues = {
        queueId,
        queueClient,
        pollingInterval,
        isRunning: true,
        stopOnError,
      };

      this.startPolling(name, consumer, handler, isBatchHandler, eventsMetadata, options);

      this.consumers.set(name, consumer);
    });
  }

  public onModuleDestroy() {
    for (const consumer of this.consumers.values()) {
      consumer.isRunning = false;
      if (consumer.timeoutId) {
        clearTimeout(consumer.timeoutId);
      }
    }
  }

  public async send<T = unknown>(name: QueueName, payload: Message<T> | Message<T>[]): Promise<void> {
    if (!this.producers.has(name)) {
      throw new Error(`Producer does not exist: ${name}`);
    }

    const producer = this.producers.get(name);
    if (!producer) {
      throw new Error(`Producer does not exist: ${name}`);
    }
    const originalMessages = Array.isArray(payload) ? payload : [payload];

    const messages: models.PutMessagesDetailsEntry[] = originalMessages.map((message) => {
      let content: string;
      if (typeof message.body === 'string') {
        content = Buffer.from(message.body).toString('base64');
      } else {
        content = Buffer.from(JSON.stringify(message.body)).toString('base64');
      }

      return {
        content,
        ...(message.metadata && {
          metadata: {
            channelId: message.metadata.channelId || 'default',
            ...(message.metadata.customProperties && {
              customProperties: message.metadata.customProperties,
            }),
          },
        }),
      };
    });

    const putMessagesDetails: models.PutMessagesDetails = {
      messages,
    };

    await producer.queueClient.putMessages({
      queueId: producer.queueId,
      putMessagesDetails,
    });
  }
}
