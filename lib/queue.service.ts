import {
  Inject,
  Injectable,
  Logger,
  type LoggerService,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { MetadataScanner, type ModuleRef, ModulesContainer, Reflector } from '@nestjs/core';
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

interface HandlerMetadata {
  meta: QueueMessageHandlerMeta;
  handler: (message: OciQueueReceivedMessage | OciQueueReceivedMessage[]) => Promise<void>;
  instance: unknown;
}

interface EventHandlerMetadata {
  meta: QueueConsumerEventHandlerMeta;
  handler: (...args: unknown[]) => unknown;
  instance: unknown;
}

@Injectable()
export class QueueService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  public readonly consumers = new Map<QueueName, OciQueueConsumerMapValues>();
  public readonly producers = new Map<QueueName, OciQueueProducerOptionsInternal>();

  private logger: LoggerService;
  private queueClients = new Map<string, QueueClient | MockQueueClient>();

  public constructor(
    @Inject(QUEUE_OPTIONS) public readonly options: QueueOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModulesContainer) private readonly modulesContainer: ModulesContainer,
    @Inject(MetadataScanner) private readonly metadataScanner: MetadataScanner,
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
    if (Array.from(this.modulesContainer.entries()).length === 0) {
      try {
        const globalApp = (
          global as {
            __NEST_APP__?: { container?: { modules?: ModulesContainer } };
          }
        ).__NEST_APP__;
        if (globalApp?.container?.modules) {
          Object.setPrototypeOf(this.modulesContainer, globalApp.container.modules);
          const globalModules = Array.from(globalApp.container.modules.entries());
          for (const [key, value] of globalModules) {
            (this.modulesContainer as Map<unknown, unknown>).set(key, value);
          }
        }
      } catch {}
    }

    let messageHandlers: HandlerMetadata[] = [];
    let eventHandlers: EventHandlerMetadata[] = [];
    const maxRetries = 5;
    const delays = [100, 200, 500, 1000, 2000];

    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
      messageHandlers = this.discoverMessageHandlers();
      eventHandlers = this.discoverEventHandlers();

      if (messageHandlers.length > 0) {
        break;
      }
    }

    if (messageHandlers.length === 0) {
      const moduleCount = Array.from(this.modulesContainer.entries()).length;
      this.logger.warn(
        `No message handlers found after ${maxRetries} attempts. ` +
          `Modules scanned: ${moduleCount}. ` +
          `ModuleRef available: ${this.moduleRef ? 'yes' : 'no'}. ` +
          `Make sure your @Injectable() classes with @QueueConsumer() decorators are registered in a module.`,
      );
    } else {
      this.logger.log(
        `Found ${messageHandlers.length} message handler(s): ${messageHandlers.map((h) => h.meta.name).join(', ')}`,
      );
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

      const handlerMetadata = messageHandlers.find((h) => h.meta.name === name);
      if (!handlerMetadata) {
        const availableHandlers = messageHandlers.map((h) => h.meta.name);
        this.logger.warn(
          `No handler found for queue '${name}'. ` +
            `Available handlers: [${availableHandlers.join(', ') || 'none'}]. ` +
            `Make sure you have a method decorated with @QueueConsumer('${name}') in an @Injectable() class.`,
        );
        return;
      }

      const isBatchHandler = handlerMetadata.meta.batch === true;
      const handler = handlerMetadata.handler.bind(handlerMetadata.instance);

      const queueEventHandlers = eventHandlers.filter((h) => h.meta.name === name);

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

      this.startPolling(name, consumer, handler, isBatchHandler, queueEventHandlers, options);

      this.consumers.set(name, consumer);
    });
  }

  private discoverMessageHandlers(): HandlerMetadata[] {
    const handlers: HandlerMetadata[] = [];
    const processedInstances = new WeakSet<object>();

    const moduleEntries = Array.from(this.modulesContainer.entries());
    if (moduleEntries.length === 0) {
      this.logger.debug('ModulesContainer is empty, trying alternative discovery method');
      return this.discoverHandlersViaModuleRef();
    }

    for (const [, module] of moduleEntries) {
      const providers = module.providers;

      if (!providers) {
        continue;
      }

      for (const [providerToken, providerDefinition] of providers.entries()) {
        if (
          typeof providerToken === 'string' &&
          (providerToken.includes('ModuleRef') ||
            providerToken.includes('Reflector') ||
            providerToken.includes('ModulesContainer') ||
            providerToken.includes('MetadataScanner') ||
            providerToken.includes('QueueService') ||
            providerToken.includes('QUEUE_OPTIONS'))
        ) {
          continue;
        }

        let instance: unknown;

        try {
          if (providerDefinition.instance) {
            instance = providerDefinition.instance;
          } else if (this.moduleRef && typeof providerToken === 'function') {
            try {
              instance = this.moduleRef.get(providerToken, { strict: false });
            } catch {
              try {
                const className = providerToken.name;
                if (className && className !== 'Function' && className !== 'Object') {
                  instance = this.moduleRef.get(className, { strict: false });
                }
              } catch {
                try {
                  if (module.instance) {
                    instance = module.instance;
                  }
                } catch {}
              }
            }
          } else if (module.instance) {
            instance = module.instance;
          }
        } catch {
          continue;
        }

        if (!instance || typeof instance !== 'object') {
          continue;
        }

        if (processedInstances.has(instance)) {
          continue;
        }
        processedInstances.add(instance);

        this.scanInstanceForHandlers(instance, handlers);
      }
    }

    return handlers;
  }

  private discoverHandlersViaModuleRef(): HandlerMetadata[] {
    const handlers: HandlerMetadata[] = [];

    if (!this.moduleRef) {
      return handlers;
    }

    const knownConsumerClasses = ['SendMessageConsumer', 'WebhookConsumer', 'DeadLetterQueueConsumer'];

    for (const className of knownConsumerClasses) {
      try {
        const instance = this.moduleRef.get(className, { strict: false });
        if (instance && typeof instance === 'object') {
          this.scanInstanceForHandlers(instance, handlers);
        }
      } catch {}
    }

    return handlers;
  }

  private scanInstanceForHandlers(instance: unknown, handlers: HandlerMetadata[]): void {
    if (!instance || typeof instance !== 'object') {
      return;
    }

    const prototype = Object.getPrototypeOf(instance);
    if (!prototype) {
      return;
    }

    const methodNames = this.metadataScanner.getAllMethodNames(prototype);

    for (const methodName of methodNames) {
      try {
        const method = prototype[methodName];
        if (typeof method !== 'function') {
          continue;
        }

        const metadata = this.reflector.get<QueueMessageHandlerMeta>(QUEUE_CONSUMER_METHOD, method);

        if (metadata) {
          handlers.push({
            meta: metadata,
            handler: method as (message: OciQueueReceivedMessage | OciQueueReceivedMessage[]) => Promise<void>,
            instance,
          });
        }
      } catch {}
    }
  }

  private discoverEventHandlers(): EventHandlerMetadata[] {
    const handlers: EventHandlerMetadata[] = [];

    for (const [, module] of this.modulesContainer.entries()) {
      const providers = module.providers;

      if (!providers) {
        continue;
      }

      for (const [providerToken, providerDefinition] of providers.entries()) {
        if (
          typeof providerToken === 'string' &&
          (providerToken.includes('ModuleRef') ||
            providerToken.includes('Reflector') ||
            providerToken.includes('ModulesContainer') ||
            providerToken.includes('MetadataScanner') ||
            providerToken.includes('QueueService') ||
            providerToken.includes('QUEUE_OPTIONS'))
        ) {
          continue;
        }

        let instance: unknown;

        try {
          if (providerDefinition.instance) {
            instance = providerDefinition.instance;
          } else if (typeof providerToken === 'function') {
            if (this.moduleRef) {
              try {
                instance = this.moduleRef.get(providerToken, { strict: false });
              } catch {
                try {
                  const className = providerToken.name;
                  if (className) {
                    instance = this.moduleRef.get(className, { strict: false });
                  }
                } catch {
                  try {
                    instance = module.instance;
                  } catch {
                    continue;
                  }
                }
              }
            } else {
              try {
                instance = module.instance;
              } catch {
                continue;
              }
            }
          } else {
            try {
              instance = module.instance;
            } catch {
              continue;
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

            const metadata = this.reflector.get<QueueConsumerEventHandlerMeta>(QUEUE_CONSUMER_EVENT_HANDLER, method);

            if (metadata) {
              handlers.push({
                meta: metadata,
                handler: method,
                instance,
              });
            }
          } catch {}
        }
      }
    }

    return handlers;
  }

  private async startPolling(
    name: QueueName,
    consumer: OciQueueConsumerMapValues,
    handler: (message: OciQueueReceivedMessage | OciQueueReceivedMessage[]) => Promise<void>,
    isBatchHandler: boolean,
    eventHandlers: EventHandlerMetadata[],
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
            const content = msg.content || '';
            let decodedContent = '';
            try {
              decodedContent = Buffer.from(content, 'base64').toString('utf-8');
            } catch {
              decodedContent = content;
            }

            receivedMessages[i] = {
              id: String(msg.id || ''),
              receiptHandle: msg.receipt || '',
              content,
              metadata: msg.metadata?.customProperties,
              Body: decodedContent,
              MessageId: String(msg.id || ''),
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
            this.emitEvent(eventHandlers, 'processing_error', error, receivedMessages);

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
        this.emitEvent(eventHandlers, 'error', error, []);
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
    eventHandlers: EventHandlerMetadata[],
    eventName: string,
    error: unknown,
    messages: OciQueueReceivedMessage[],
  ) {
    const eventMetadata = eventHandlers.find((h) => h.meta.eventName === eventName);
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
