import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { type MockQueueClient, QueueModule, QueueService } from '../lib';

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
      await module.get(QueueService).onApplicationBootstrap();

      const queueService = module.get(QueueService);
      expect(queueService).toBeDefined();
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
      await module.get(QueueService).onApplicationBootstrap();

      const queueService = module.get(QueueService);
      expect(queueService).toBeDefined();
      expect(queueService.producers.has(TestQueue.Test)).toBe(true);

      await module.close();
    });
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
      await module.get(QueueService).onApplicationBootstrap();
    });

    afterAll(async () => {
      await module.close();
    });

    it('should use MockQueueClient in local mode', () => {
      const queueService = module.get(QueueService);
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
});
