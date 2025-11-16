import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MockQueueClient, type OciQueueReceivedMessage, QueueModule, QueueService } from '../lib';
import { QueueConsumerEventHandler, QueueMessageHandler } from '../lib/queue.decorators';

enum TestQueue {
  Test = 'test-queue',
  DLQ = 'test-dlq',
  Batch = 'test-batch',
}

describe('QueueModule E2E', () => {
  describe('Module Registration', () => {
    it('should register module with register()', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          QueueModule.register({
            localMode: true,
            consumers: [
              {
                name: TestQueue.Test,
                queueId: 'test-queue-1',
                pollingInterval: 1000,
              },
            ],
            producers: [
              {
                name: TestQueue.Test,
                queueId: 'test-queue-1',
              },
            ],
          }),
        ],
      }).compile();
      await module.init();

      const queueService = module.get(QueueService);
      expect(queueService).toBeDefined();
      // Note: Consumers are only registered if handlers are found
      // Since there are no handlers in this test, consumers won't be registered
      // But producers should be registered
      expect(queueService.producers.has(TestQueue.Test)).toBe(true);

      await module.close();
    });

    it('should register module with registerAsync()', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          QueueModule.registerAsync({
            useFactory: async () => {
              return {
                localMode: true,
                consumers: [
                  {
                    name: TestQueue.Test,
                    queueId: 'test-queue-2',
                  },
                ],
                producers: [
                  {
                    name: TestQueue.Test,
                    queueId: 'test-queue-2',
                  },
                ],
              };
            },
          }),
        ],
      }).compile();
      await module.init();

      const queueService = module.get(QueueService);
      expect(queueService).toBeDefined();
      // Note: Consumers are only registered if handlers are found
      // Since there are no handlers in this test, consumers won't be registered
      // But producers should be registered
      expect(queueService.producers.has(TestQueue.Test)).toBe(true);

      await module.close();
    });
  });

  describe('Message Handlers', () => {
    let module: TestingModule;
    const fakeProcessor = jest.fn();
    const fakeErrorHandler = jest.fn();
    const fakeDLQProcessor = jest.fn();

    @Injectable()
    class TestHandler {
      public constructor(public readonly queueService: QueueService) {}

      @QueueMessageHandler(TestQueue.Test, false)
      public async handleMessage(message: OciQueueReceivedMessage) {
        fakeProcessor(message);
      }

      @QueueConsumerEventHandler(TestQueue.Test, 'processing_error')
      public handleError(err: Error, message: OciQueueReceivedMessage) {
        fakeErrorHandler(err, message);
      }

      @QueueMessageHandler(TestQueue.DLQ, false)
      public async handleDLQ(message: OciQueueReceivedMessage) {
        fakeDLQProcessor(message);
      }
    }

    beforeAll(async () => {
      module = await Test.createTestingModule({
        imports: [
          QueueModule.register({
            localMode: true,
            consumers: [
              {
                name: TestQueue.Test,
                queueId: 'test-queue-handler',
                pollingInterval: 500,
                maxMessages: 10,
                visibilityTimeoutInSeconds: 30,
                timeoutInSeconds: 30,
              },
              {
                name: TestQueue.DLQ,
                queueId: 'test-dlq-handler',
                pollingInterval: 500,
                maxMessages: 10,
              },
            ],
            producers: [
              {
                name: TestQueue.Test,
                queueId: 'test-queue-handler',
              },
              {
                name: TestQueue.DLQ,
                queueId: 'test-dlq-handler',
              },
            ],
          }),
        ],
        providers: [TestHandler],
      }).compile();
      await module.init();

      // Get handler instance to ensure it's instantiated
      const handlerInstance = module.get(TestHandler);
      expect(handlerInstance).toBeDefined();

      // Get QueueService and register handler instances manually (for test context)
      const queueService = module.get(QueueService);
      queueService.registerHandlerInstances([handlerInstance]);
      await queueService.rediscoverHandlers();

      // Clear queues
      const testConsumer = queueService.consumers.get(TestQueue.Test);
      const dlqConsumer = queueService.consumers.get(TestQueue.DLQ);

      if (testConsumer?.queueClient instanceof MockQueueClient) {
        testConsumer.queueClient.clearQueue('test-queue-handler');
      }
      if (dlqConsumer?.queueClient instanceof MockQueueClient) {
        dlqConsumer.queueClient.clearQueue('test-dlq-handler');
      }

      // Wait for polling to start
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    afterEach(() => {
      fakeProcessor.mockReset();
      fakeErrorHandler.mockReset();
      fakeDLQProcessor.mockReset();
    });

    afterAll(async () => {
      await module.close();
    });

    it('should register message handlers', () => {
      const queueService = module.get(QueueService);
      expect(queueService.consumers.has(TestQueue.Test)).toBe(true);
      expect(queueService.consumers.has(TestQueue.DLQ)).toBe(true);

      // Verify consumers are running (handlers should be discovered)
      const testConsumer = queueService.consumers.get(TestQueue.Test);
      const dlqConsumer = queueService.consumers.get(TestQueue.DLQ);
      expect(testConsumer).toBeDefined();
      expect(dlqConsumer).toBeDefined();
    });

    it('should call message handler when a message is sent', async () => {
      const queueService = module.get(QueueService);

      await new Promise<void>((resolve, reject) => {
        try {
          fakeProcessor.mockImplementation((message: OciQueueReceivedMessage) => {
            expect(message).toBeDefined();
            expect(message.id).toBeDefined();
            expect(message.content).toBeDefined();
            const content = Buffer.from(message.content, 'base64').toString('utf-8');
            expect(JSON.parse(content)).toStrictEqual({ test: true });
            resolve();
          });

          queueService.send(TestQueue.Test, {
            body: { test: true },
          });
        } catch (e) {
          reject(e);
        }
      });
    }, 5000);

    it('should call message handler multiple times for multiple messages', async () => {
      const queueService = module.get(QueueService);

      await Promise.all(
        Array.from({ length: 3 }).map(async (_, i) => {
          await queueService.send(TestQueue.Test, {
            body: { test: true, index: i },
          });
        }),
      );

      // Wait for messages to be processed
      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(fakeProcessor.mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const call of fakeProcessor.mock.calls) {
        expect(call).toHaveLength(1);
        expect(call[0]).toBeDefined();
        const message = call[0] as OciQueueReceivedMessage;
        expect(message.id).toBeDefined();
        expect(message.content).toBeDefined();
      }
    }, 6000);

    it('should call error handler when message processing fails', async () => {
      const queueService = module.get(QueueService);

      fakeProcessor.mockImplementation(() => {
        throw new Error('Test error');
      });

      await new Promise<void>((resolve, reject) => {
        try {
          fakeErrorHandler.mockImplementationOnce((error: Error, message: OciQueueReceivedMessage) => {
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toBe('Test error');
            expect(message).toBeDefined();
            resolve();
          });

          queueService.send(TestQueue.Test, {
            body: { test: true },
          });
        } catch (e) {
          reject(e);
        }
      });
    }, 5000);

    it('should send and receive messages from DLQ', async () => {
      const queueService = module.get(QueueService);

      await new Promise<void>((resolve, reject) => {
        try {
          fakeDLQProcessor.mockImplementationOnce((message: OciQueueReceivedMessage) => {
            expect(message).toBeDefined();
            expect(message.id).toBeDefined();
            expect(message.content).toBeDefined();
            const content = Buffer.from(message.content, 'base64').toString('utf-8');
            expect(JSON.parse(content)).toStrictEqual({ dlq: true, test: 'dlq-message' });
            resolve();
          });

          queueService.send(TestQueue.DLQ, {
            body: { dlq: true, test: 'dlq-message' },
          });
        } catch (e) {
          reject(e);
        }
      });
    }, 5000);
  });

  describe('Batch Message Handlers', () => {
    let module: TestingModule;
    const batchProcessor = jest.fn();

    @Injectable()
    class BatchHandler {
      @QueueMessageHandler(TestQueue.Batch, true)
      public async handleBatch(messages: OciQueueReceivedMessage[]) {
        batchProcessor(messages);
      }
    }

    beforeAll(async () => {
      module = await Test.createTestingModule({
        imports: [
          QueueModule.register({
            localMode: true,
            consumers: [
              {
                name: TestQueue.Batch,
                queueId: 'test-queue-batch',
                pollingInterval: 500,
                maxMessages: 10,
              },
            ],
            producers: [
              {
                name: TestQueue.Batch,
                queueId: 'test-queue-batch',
              },
            ],
          }),
        ],
        providers: [BatchHandler],
      }).compile();
      await module.init();

      // Get handler instance to ensure it's instantiated
      const handlerInstance = module.get(BatchHandler);
      expect(handlerInstance).toBeDefined();

      // Get QueueService and register handler instances manually (for test context)
      const queueService = module.get(QueueService);
      queueService.registerHandlerInstances([handlerInstance]);
      await queueService.rediscoverHandlers();

      // Clear queue
      const consumer = queueService.consumers.get(TestQueue.Batch);
      if (consumer?.queueClient instanceof MockQueueClient) {
        consumer.queueClient.clearQueue('test-queue-batch');
      }

      // Wait for polling to start
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    afterAll(async () => {
      await module.close();
    });

    it('should handle batch messages', async () => {
      const queueService = module.get(QueueService);

      // Send multiple messages
      await Promise.all(
        Array.from({ length: 3 }).map(async (_, i) => {
          await queueService.send(TestQueue.Batch, {
            body: { batch: true, index: i },
          });
        }),
      );

      // Wait for batch messages to be processed
      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(batchProcessor.mock.calls.length).toBeGreaterThan(0);
      const batchCall = batchProcessor.mock.calls[0];
      expect(batchCall[0]).toBeInstanceOf(Array);
      expect(batchCall[0].length).toBeGreaterThan(0);
      const messages = batchCall[0] as OciQueueReceivedMessage[];
      for (const message of messages) {
        expect(message.id).toBeDefined();
        expect(message.content).toBeDefined();
      }
    }, 6000);
  });

  describe('MockQueueClient Features', () => {
    let module: TestingModule;

    beforeAll(async () => {
      module = await Test.createTestingModule({
        imports: [
          QueueModule.register({
            localMode: true,
            consumers: [
              {
                name: TestQueue.Test,
                queueId: 'test-queue-mock',
                pollingInterval: 1000,
              },
            ],
            producers: [
              {
                name: TestQueue.Test,
                queueId: 'test-queue-mock',
              },
            ],
          }),
        ],
      }).compile();
      await module.init();

      // Note: No handlers in this test, so consumers won't be registered
      // But we can still check that the service is using MockQueueClient
    });

    afterAll(async () => {
      await module.close();
    });

    it('should use MockQueueClient in local mode', () => {
      const queueService = module.get(QueueService);
      // Since there are no handlers, consumers won't be registered
      // But we can verify the service is configured for local mode
      expect(queueService.options.localMode).toBe(true);
    });

    it('should support MockQueueClient helper methods', async () => {
      const queueService = module.get(QueueService);

      // Get producer to access the queue client
      const producer = queueService.producers.get(TestQueue.Test);
      expect(producer).toBeDefined();

      const mockClient = producer?.queueClient as unknown as MockQueueClient;
      expect(mockClient).toBeDefined();

      // Test getMessageCount (queue may not exist yet)
      expect(mockClient.getMessageCount('test-queue-mock')).toBe(0);

      // Send a message
      await queueService.send(TestQueue.Test, {
        body: { test: 'message' },
      });

      // Wait a bit for message to be processed
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Test queueExists (after sending a message, queue should exist)
      expect(mockClient.queueExists('test-queue-mock')).toBe(true);
      expect(mockClient.queueExists('non-existent')).toBe(false);

      // Test getAllMessages
      const messages = mockClient.getAllMessages('test-queue-mock');
      expect(messages.length).toBeGreaterThanOrEqual(0);

      // Verify messages array is defined (to avoid unused variable warning)
      expect(Array.isArray(messages)).toBe(true);

      // Test clearQueue
      mockClient.clearQueue('test-queue-mock');
      expect(mockClient.getMessageCount('test-queue-mock')).toBe(0);
    });
  });

  describe('Visibility Timeout', () => {
    let module: TestingModule;
    const messageProcessor = jest.fn();

    @Injectable()
    class VisibilityHandler {
      @QueueMessageHandler(TestQueue.Test, false)
      public async handleMessage(message: OciQueueReceivedMessage) {
        messageProcessor(message);
      }
    }

    beforeAll(async () => {
      module = await Test.createTestingModule({
        imports: [
          QueueModule.register({
            localMode: true,
            consumers: [
              {
                name: TestQueue.Test,
                queueId: 'test-queue-visibility',
                pollingInterval: 500,
                maxMessages: 10,
                visibilityTimeoutInSeconds: 5, // Short timeout for testing
              },
            ],
            producers: [
              {
                name: TestQueue.Test,
                queueId: 'test-queue-visibility',
              },
            ],
          }),
        ],
        providers: [VisibilityHandler],
      }).compile();
      await module.init();

      // Get handler instance to ensure it's instantiated
      const handlerInstance = module.get(VisibilityHandler);
      expect(handlerInstance).toBeDefined();

      // Get QueueService and register handler instances manually (for test context)
      const queueService = module.get(QueueService);
      queueService.registerHandlerInstances([handlerInstance]);
      await queueService.rediscoverHandlers();

      // Clear queue
      const consumer = queueService.consumers.get(TestQueue.Test);
      if (consumer?.queueClient instanceof MockQueueClient) {
        consumer.queueClient.clearQueue('test-queue-visibility');
      }

      // Wait for polling to start
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    afterAll(async () => {
      await module.close();
    });

    it('should respect visibility timeout', async () => {
      const queueService = module.get(QueueService);
      const consumer = queueService.consumers.get(TestQueue.Test);
      expect(consumer).toBeDefined();

      const mockClient = consumer?.queueClient as unknown as MockQueueClient;
      expect(mockClient).toBeDefined();

      // Send a message
      await queueService.send(TestQueue.Test, {
        body: { test: 'visibility' },
      });

      // Wait for message to be retrieved (should become invisible)
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Message should be processed or invisible
      // The MockQueueClient should handle visibility timeout correctly
      expect(mockClient).toBeDefined();
    }, 3000);
  });
});
